/**
 * Typed environment bindings for the Worker.
 *
 * Set via `wrangler.toml [vars]` (public) and `wrangler secret put` (secret).
 */

export interface Env {
  // KV namespace holding encrypted user API tokens, keyed by session ID.
  EDGEGAP_MCP_KV: KVNamespace;

  // Public URL of THIS Worker — used to build redirect/callback URLs in the
  // browser-based connect flow.
  PUBLIC_BASE_URL: string;

  // Edgegap API base URL — overridable per environment for staging.
  EDGEGAP_API_BASE_URL: string;

  // Secret: 64-hex-char key used to encrypt API tokens at rest in KV.
  // Generate with `openssl rand -hex 32`, set via `wrangler secret put TOKEN_ENCRYPTION_KEY`.
  TOKEN_ENCRYPTION_KEY: string;

  // Secret: 64-hex-char key used to HMAC-sign session cookies / paste tokens.
  // Generate with `openssl rand -hex 32`, set via `wrangler secret put SESSION_SIGNING_KEY`.
  SESSION_SIGNING_KEY: string;
}
