/**
 * Cloudflare Worker — remote Streamable HTTP transport for the Edgegap MCP server.
 *
 * Read worker/DECISION.md before deploying. Summary of the trade: the
 * developer's Edgegap API token passes through Edgegap infrastructure on every
 * call. Nothing is stored — no KV, no D1, no Durable Object, no logs, no cache
 * — but "not stored" is a weaker claim than "never seen", and the local server
 * (npx @edgegap/mcp) makes the stronger one.
 *
 * Run this when you need what local cannot do: web and mobile MCP clients with
 * no local process, shared demo environments, or a URL you can put in a deck.
 *
 * AUTH SHAPE — read this before adding a gate back.
 *
 * There is deliberately no HTTP 401 gate on /mcp. A transport-level 401 is the
 * spec's way of saying "go authenticate over there", and it is only useful when
 * there is an OAuth authorization server to point at. There is not one yet (see
 * DECISION.md), so a blanket 401 produced three bad outcomes:
 *
 *   1. initialize and tools/list failed, so no client could even see what this
 *      server does without a credential. Tool listings are not secret — the
 *      whole repo is public — and discovery has no business requiring a token.
 *   2. Clients that cannot attach a static header (claude.ai custom connectors,
 *      for one) sent their OWN bearer token, which satisfied a bare
 *      "is the header present" check and got relayed to the Edgegap API, which
 *      rejected it with an opaque 401 the developer could not act on.
 *   3. Clients rendered "sign-in: not required" anyway, because the challenge
 *      carried no RFC 9728 resource_metadata pointing at an authorization
 *      server. The badge was right; the gate was the broken part.
 *
 * So: every request reaches the MCP handler. Discovery works anonymously. Tools
 * that need a credential fail per-call through TokenUnavailableError, which
 * surfaces as readable text in the agent's transcript instead of a dead socket.
 */

import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import type { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EdgegapClient } from '../src/client.js';
import { StaticTokenProvider } from '../src/auth.js';
import { registerTools, serverInstructions } from '../src/tools.js';
import type { Config } from '../src/config.js';
import { extractToken, unavailableMessage } from '../src/hosted.js';

export interface Env {
  EDGEGAP_APP_ALLOWLIST?: string;
  EDGEGAP_MAX_DURATION_MINUTES?: string;
  EDGEGAP_READ_ONLY?: string;
}

/**
 * Config for a single request. envToken is always undefined: the hosted server
 * has no ambient credential of its own, by design. If you ever find yourself
 * adding one, stop and re-read DECISION.md.
 */
function configForRequest(env: Env): Config {
  return {
    envToken: undefined,
    baseUrlV1: 'https://api.edgegap.com',
    baseUrlV2: 'https://api.edgegap.com/v2',
    readOnly: env.EDGEGAP_READ_ONLY === '1',
    appAllowlist: (env.EDGEGAP_APP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxDurationCeiling: Number.parseInt(env.EDGEGAP_MAX_DURATION_MINUTES ?? '60', 10) || 60,
    requestTimeoutMs: 25_000, // inside the Worker subrequest budget
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Token-free, so uptime checks need no credential.
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // startsWith, not strict equality: Streamable HTTP uses subpaths and an
    // equality check breaks the connection in a way that is hard to debug.
    if (!url.pathname.startsWith('/mcp')) {
      return new Response('Not found', { status: 404 });
    }

    const { token, problem } = extractToken(request.headers.get('Authorization'));
    const config = configForRequest(env);

    const handler = createMcpHandler(() => {
      const server = new McpServer(
        { name: 'edgegap', version: '0.3.1' },
        { instructions: serverInstructions('hosted') }
      );

      // The tool definitions are shared verbatim with the local server.
      // The cast bridges SDK v1 (which src/tools.ts is typed against) and v2:
      // registerTool's raw-zod-shape overload still exists in v2, so the call
      // shape is identical at runtime. When src/ moves to v2, delete the cast.
      //
      // Registration does not need a token — that is the point. The tools are
      // described to any client that asks, and only fail when one is CALLED
      // without a credential.
      const auth = new StaticTokenProvider(
        token,
        problem ? unavailableMessage(problem) : undefined
      );
      registerTools(
        server as unknown as McpServerV1,
        new EdgegapClient(config, auth),
        config,
        auth
      );

      return server;
    });

    return handler(request, env, ctx);
  },
};
