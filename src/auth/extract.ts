/**
 * Extract a session identifier from an incoming MCP request.
 *
 * Accepts the Bearer token issued at /connect:
 *   Authorization: Bearer mcp_<signed_session_id>
 *
 * Returns the verified opaque session ID, or null if the header is missing,
 * malformed, or fails HMAC verification.
 */

import type { Env } from "../lib/env.js";
import { verifySignedValue } from "../lib/crypto.js";

export async function extractSessionId(
  req: Request,
  env: Env,
): Promise<string | null> {
  const auth = req.headers.get("Authorization") ?? "";
  const m = auth.match(/^Bearer\s+mcp_(.+)$/i);
  if (!m) return null;
  const signed = m[1];
  return await verifySignedValue(signed, env.SESSION_SIGNING_KEY);
}
