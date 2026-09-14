/**
 * Connect flow.
 *
 * GET /connect           → HTML form: paste token, pick scope
 * POST /connect          → validates token against Edgegap, stores encrypted in KV,
 *                          returns success page with the signed session ID for
 *                          the user to paste into their MCP client config.
 *
 * The session ID is presented in two forms:
 *   - As a Bearer-style token: `Authorization: Bearer mcp_<signed_session>`
 *   - As a cookie automatically set on the browser session (rarely used —
 *     most MCP clients don't share a cookie jar with the browser).
 *
 * Why the paste-token flow lives in this Worker (rather than a separate site):
 *   - The Worker already needs to encrypt + write to KV; centralizing avoids
 *     a second deployment surface.
 *   - The success page can deep-link directly to claude://, cursor://, etc.
 *     to add the MCP server to those clients.
 */

import type { Env } from "../lib/env.js";
import { EdgegapClient } from "../lib/client.js";
import {
  generateSessionId,
  signValue,
} from "../lib/crypto.js";
import { createSession, type AccessScope } from "../lib/sessions.js";

/** Render the GET /connect page. */
export function renderConnectPage(env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Edgegap MCP</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
           max-width: 560px; margin: 4rem auto; padding: 0 1.5rem;
           line-height: 1.5; color: #1a1a1a; background: #fafafa; }
    @media (prefers-color-scheme: dark) {
      body { color: #eaeaea; background: #0f0f0f; }
      input, select { background: #1a1a1a; color: #eaeaea; border-color: #333; }
      .card { background: #1a1a1a; border-color: #333; }
      .muted { color: #888; }
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    .card { background: #fff; border: 1px solid #e5e5e5; border-radius: 12px;
            padding: 1.5rem; margin-top: 1.5rem; }
    label { display: block; font-weight: 600; margin-top: 1rem; margin-bottom: 0.25rem; }
    input[type=text], input[type=password], select {
      width: 100%; padding: 0.6rem 0.75rem; border: 1px solid #d4d4d4;
      border-radius: 8px; font-size: 0.95rem; box-sizing: border-box;
      font-family: ui-monospace, monospace;
    }
    button { margin-top: 1.5rem; width: 100%; padding: 0.75rem; border: none;
             border-radius: 8px; background: #0066ff; color: #fff;
             font-size: 1rem; font-weight: 600; cursor: pointer; }
    button:hover { background: #0052cc; }
    .muted { color: #666; font-size: 0.875rem; }
    .scope-card { display: flex; gap: 0.75rem; align-items: flex-start;
                  padding: 0.75rem; border: 1px solid #e5e5e5;
                  border-radius: 8px; margin-bottom: 0.5rem; cursor: pointer; }
    .scope-card input { margin-top: 0.25rem; width: auto; }
    .scope-card strong { display: block; }
    .scope-card.selected { border-color: #0066ff; background: rgba(0,102,255,0.06); }
    a { color: #0066ff; }
  </style>
</head>
<body>
  <h1>Connect Edgegap to your AI assistant</h1>
  <p class="muted">
    This page links your Edgegap account to the MCP server at
    <code>${env.PUBLIC_BASE_URL.replace(/^https?:\/\//, "")}</code>
    so AI assistants like Claude, Cursor, and Windsurf can act on your behalf.
  </p>

  <div class="card">
    <form method="POST" action="/connect">
      <label for="token">Edgegap API token</label>
      <input type="password" id="token" name="token" required
             placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
             autocomplete="off" spellcheck="false">
      <p class="muted">
        Generate one at
        <a href="https://app.edgegap.com/user-settings?tab=tokens" target="_blank">
          app.edgegap.com → User Settings → Tokens
        </a>. The token is encrypted before storage and never shown again.
      </p>

      <label>Access scope</label>
      <label class="scope-card selected" id="scope-read-label">
        <input type="radio" name="scope" value="read" checked
               onchange="updateScopeUi()">
        <span>
          <strong>Read-only</strong>
          <span class="muted">List apps, view deployments, check status. No deploys, no stops, no edits. <em>Recommended for first use.</em></span>
        </span>
      </label>
      <label class="scope-card" id="scope-full-label">
        <input type="radio" name="scope" value="full" onchange="updateScopeUi()">
        <span>
          <strong>Full access</strong>
          <span class="muted">Everything above + deploy, stop, modify apps. The assistant can change production state.</span>
        </span>
      </label>

      <button type="submit">Connect</button>
    </form>
  </div>

  <p class="muted" style="margin-top: 1.5rem;">
    Your token never leaves this server. It's encrypted with AES-GCM and stored
    in Cloudflare KV. To revoke access, delete the API token in your Edgegap dashboard.
  </p>

  <script>
    function updateScopeUi() {
      const read = document.querySelector('input[value=read]').checked;
      document.getElementById('scope-read-label').classList.toggle('selected', read);
      document.getElementById('scope-full-label').classList.toggle('selected', !read);
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Handle POST /connect — verify token, store, return success page. */
export async function handleConnectSubmit(
  req: Request,
  env: Env,
): Promise<Response> {
  const form = await req.formData();
  const token = String(form.get("token") ?? "").trim();
  const scopeRaw = String(form.get("scope") ?? "read");
  const scope: AccessScope = scopeRaw === "full" ? "full" : "read";

  if (!token) {
    return new Response("Missing token", { status: 400 });
  }

  // Validate the token against Edgegap before we accept it.
  // A trivial call (list apps with limit=1) confirms the token is live and
  // surfaces auth errors immediately rather than at first MCP call.
  const probe = new EdgegapClient(env.EDGEGAP_API_BASE_URL, token);
  const res = await probe.request({
    method: "GET",
    path: "/v1/apps",
    query: { limit: 1 },
  });
  if (!res.ok) {
    return renderConnectError(
      res.status === 401 || res.status === 403
        ? "That token didn't work. Double-check you copied the whole value from User Settings → Tokens."
        : `Edgegap returned ${res.status} when verifying the token. Try again in a moment.`,
    );
  }

  // Token verified. Create session.
  const sessionId = generateSessionId();
  await createSession(env, sessionId, token, scope);
  const signed = await signValue(sessionId, env.SESSION_SIGNING_KEY);
  const bearer = `mcp_${signed}`;

  // The MCP URL the user pastes into their client config.
  const mcpUrl =
    scope === "full"
      ? `${env.PUBLIC_BASE_URL}/mcp/full`
      : `${env.PUBLIC_BASE_URL}/mcp`;

  return renderConnectSuccess(mcpUrl, bearer, scope);
}

function renderConnectError(message: string): Response {
  const html = `<!DOCTYPE html>
<html><head><title>Connection failed</title>
<style>body{font-family:system-ui;max-width:560px;margin:4rem auto;padding:0 1.5rem;line-height:1.5}</style>
</head><body>
<h1>Couldn't connect</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/connect">← Try again</a></p>
</body></html>`;
  return new Response(html, {
    status: 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function renderConnectSuccess(
  mcpUrl: string,
  bearerToken: string,
  scope: AccessScope,
): Response {
  // The Claude Desktop config snippet — most popular client, optimize for it.
  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        edgegap: {
          url: mcpUrl,
          headers: {
            Authorization: `Bearer ${bearerToken}`,
          },
        },
      },
    },
    null,
    2,
  );

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Connected!</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 720px;
           margin: 3rem auto; padding: 0 1.5rem; line-height: 1.5; }
    .scope { display: inline-block; padding: 0.15rem 0.6rem; border-radius: 999px;
             font-size: 0.85rem; font-weight: 600;
             background: ${scope === "full" ? "#fff4e5" : "#e6f4ea"};
             color: ${scope === "full" ? "#a04200" : "#0a6b2c"}; }
    pre { background: #0f0f0f; color: #eaeaea; padding: 1rem; border-radius: 8px;
          overflow-x: auto; font-size: 0.875rem; line-height: 1.4; }
    .warn { background: #fff4e5; border-left: 3px solid #ff9500;
            padding: 0.75rem 1rem; border-radius: 4px; margin: 1.5rem 0; }
    .muted { color: #666; font-size: 0.9rem; }
    code { background: #f0f0f0; padding: 0.1rem 0.3rem; border-radius: 3px; }
    @media (prefers-color-scheme: dark) {
      body { color: #eaeaea; background: #0f0f0f; }
      code { background: #1f1f1f; }
      .warn { background: #2a1f0f; color: #ffd599; }
    }
  </style>
</head>
<body>
  <h1>✓ Connected</h1>
  <p>
    Your Edgegap account is linked. Scope: <span class="scope">${scope === "full" ? "FULL ACCESS" : "READ-ONLY"}</span>
  </p>

  <h2>Add to Claude Desktop</h2>
  <p>Paste this into your <code>claude_desktop_config.json</code>:</p>
  <pre>${escapeHtml(claudeConfig)}</pre>

  <h2>Add to Claude Code</h2>
  <pre>claude mcp add edgegap --transport http ${mcpUrl} \\
  --header "Authorization: Bearer ${bearerToken}"</pre>

  <h2>Add to Cursor / Windsurf</h2>
  <p>Same JSON format as Claude Desktop. Drop the block above into the MCP config file.</p>

  <div class="warn">
    <strong>Save the Bearer token now.</strong> It won't be shown again.
    If you lose it, just visit <a href="/connect">/connect</a> with the same Edgegap
    token to create a new session.
  </div>

  <p class="muted">
    To disconnect: send a DELETE request to <code>${escapeHtml(new URL(mcpUrl).origin)}/session</code>
    with the Bearer token, or just delete the Edgegap API token from your dashboard.
  </p>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
