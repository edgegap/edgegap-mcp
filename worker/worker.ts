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

function extractToken(request: Request): string | undefined {
  const header = request.headers.get('Authorization');
  if (!header) return undefined;
  const value = header.replace(/^Bearer\s+/i, '').replace(/^token\s+/i, '').trim();
  return value || undefined;
}

const UNAUTHORIZED = JSON.stringify(
  {
    error: 'missing_token',
    message:
      'Send your Edgegap API token in the Authorization header of the MCP ' +
      'connection. It is used for the request and discarded — never stored. ' +
      'Edgegap tokens are organization-wide and cannot be scoped, so prefer ' +
      'the local server (npx -y @edgegap/mcp), which keeps the token on your ' +
      'own machine.',
    token_url: 'https://app.edgegap.com/user-settings?tab=tokens',
  },
  null,
  2
);

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

    const token = extractToken(request);
    if (!token) {
      return new Response(UNAUTHORIZED, {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          // Steers spec-compliant MCP clients toward an OAuth flow, once
          // Edgegap has one to point them at.
          'WWW-Authenticate': 'Bearer realm="edgegap"',
        },
      });
    }

    const config = configForRequest(env);

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'edgegap', version: '0.1.0' });

      // The ten tool definitions are shared verbatim with the local server.
      // The cast bridges SDK v1 (which src/tools.ts is typed against) and v2:
      // registerTool's raw-zod-shape overload still exists in v2, so the call
      // shape is identical at runtime. When src/ moves to v2, delete the cast.
      const auth = new StaticTokenProvider(token);
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
