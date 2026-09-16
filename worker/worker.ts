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
import { registerTools } from '../src/tools.js';
import type { Config } from '../src/config.js';

export interface Env {
  EDGEGAP_APP_ALLOWLIST?: string;
  EDGEGAP_MAX_DURATION_MINUTES?: string;
  EDGEGAP_READ_ONLY?: string;
}

const TOKEN_URL = 'https://app.edgegap.com/user-settings?tab=tokens';

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

/**
 * Edgegap API tokens are UUIDs. The strict form is the real test; the loose
 * form exists so a future token format does not silently stop working here.
 *
 * The point of this check is NOT security — an invalid token fails upstream
 * anyway. It is to tell a foreign credential apart from an Edgegap one BEFORE
 * relaying it, so the developer gets "your client sent its own token" instead
 * of Edgegap's generic 401. JWTs are the common case: they are what MCP clients
 * mint for themselves, and they always carry dots, which a UUID never does.
 */
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOSE_OPAQUE = /^[A-Za-z0-9_-]{16,200}$/;

function looksLikeEdgegapToken(value: string): boolean {
  if (STRICT_UUID.test(value)) return true;
  return LOOSE_OPAQUE.test(value);
}

type TokenResult =
  | { token: string; problem?: undefined }
  | { token: undefined; problem: 'absent' | 'foreign' };

function extractToken(request: Request): TokenResult {
  const header = request.headers.get('Authorization');
  if (!header) return { token: undefined, problem: 'absent' };

  const value = header.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '').trim();
  if (!value) return { token: undefined, problem: 'absent' };
  if (!looksLikeEdgegapToken(value)) return { token: undefined, problem: 'foreign' };

  return { token: value };
}

/**
 * The message an agent sees when it calls a tool without a usable credential.
 * It is the only place the developer is told what to do, so it says it in full
 * rather than pointing at docs.
 */
function unavailableMessage(problem: 'absent' | 'foreign'): string {
  const common =
    `Get a token at ${TOKEN_URL}. It is used for the request and discarded — ` +
    'never stored. Edgegap tokens are organization-wide and cannot be scoped, ' +
    'so prefer the local server (npx -y @edgegap/mcp), which keeps the token ' +
    'on your own machine and never sends it through Edgegap infrastructure.';

  if (problem === 'foreign') {
    return (
      'The Authorization header on this connection does not contain an Edgegap ' +
      'API token — it looks like a credential your MCP client issued for ' +
      'itself. That happens with clients that connect by URL alone and have no ' +
      'field for a custom header. This server was not going to relay it to the ' +
      'Edgegap API, because the only thing that produces is a confusing 401.\n\n' +
      'If your client cannot attach your own Edgegap token to the connection, ' +
      'it cannot use this hosted server: run the local one instead ' +
      '(npx -y @edgegap/mcp).\n\n' +
      common
    );
  }

  return (
    'No Edgegap API token on this request. Send it as an Authorization header ' +
    'on the MCP connection.\n\n' +
    common
  );
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

    const { token, problem } = extractToken(request);
    const config = configForRequest(env);

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'edgegap', version: '0.1.0' });

      // The ten tool definitions are shared verbatim with the local server.
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
