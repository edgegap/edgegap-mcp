/**
 * Per-request token handling shared by the two hosted transports: the
 * Cloudflare Worker (worker/worker.ts) and the Node HTTP server (src/http.ts).
 *
 * Neither has an ambient credential. Each request carries the developer's own
 * Edgegap token in its Authorization header, and it is used for that request
 * and discarded. See worker/DECISION.md.
 */

import { stripTokenPrefix } from './config.js';

const TOKEN_URL = 'https://app.edgegap.com/user-settings?tab=tokens';

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

export type TokenResult =
  | { token: string; problem?: undefined }
  | { token: undefined; problem: 'absent' | 'foreign' };

export function extractToken(header: string | null | undefined): TokenResult {
  if (!header) return { token: undefined, problem: 'absent' };

  // Any run of "Bearer "/"token ", so "token token <uuid>" still works.
  const value = stripTokenPrefix(header);
  if (!value) return { token: undefined, problem: 'absent' };
  if (!looksLikeEdgegapToken(value)) return { token: undefined, problem: 'foreign' };

  return { token: value };
}

/**
 * The message an agent sees when it calls a tool without a usable credential.
 * It is the only place the developer is told what to do, so it says it in full
 * rather than pointing at docs.
 */
export function unavailableMessage(problem: 'absent' | 'foreign'): string {
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
