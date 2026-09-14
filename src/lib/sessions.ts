/**
 * Session store, KV-backed.
 *
 * Each session record holds:
 *   - the user's Edgegap API token (encrypted at rest)
 *   - the access scope they chose at connect time ("read" or "full")
 *   - timestamps for audit / TTL
 *
 * Sessions are keyed by an opaque session ID. We never bind a session to an
 * email or user identity — by design, per the v0.2 architecture decision.
 *
 * KV key layout:
 *   session:<sessionId> → JSON blob
 */

import type { Env } from "./env.js";
import { decryptToken, encryptToken } from "./crypto.js";

export type AccessScope = "read" | "full";

export interface SessionRecord {
  /** Encrypted API token (AES-GCM, base64url). Never written or returned in cleartext. */
  encryptedToken: string;
  /** Scope chosen at connect time. */
  scope: AccessScope;
  /** When the session was created (ISO 8601). */
  createdAt: string;
  /** Last time this session called a tool (ISO 8601, may be stale by minutes). */
  lastUsedAt: string;
}

const KV_PREFIX = "session:";

/** Persist a freshly created session. */
export async function createSession(
  env: Env,
  sessionId: string,
  apiToken: string,
  scope: AccessScope,
): Promise<void> {
  const encryptedToken = await encryptToken(apiToken, env.TOKEN_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  const record: SessionRecord = {
    encryptedToken,
    scope,
    createdAt: now,
    lastUsedAt: now,
  };
  // 90-day TTL. Tokens that go unused for that long get rotated out.
  await env.EDGEGAP_MCP_KV.put(KV_PREFIX + sessionId, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
}

/** Load a session by ID and decrypt the API token. Returns null if missing. */
export async function getSession(
  env: Env,
  sessionId: string,
): Promise<{ scope: AccessScope; apiToken: string; record: SessionRecord } | null> {
  const raw = await env.EDGEGAP_MCP_KV.get(KV_PREFIX + sessionId);
  if (!raw) return null;
  let record: SessionRecord;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  const apiToken = await decryptToken(
    record.encryptedToken,
    env.TOKEN_ENCRYPTION_KEY,
  );
  return { scope: record.scope, apiToken, record };
}

/**
 * Update lastUsedAt on a session — best-effort, non-blocking.
 * Use ctx.waitUntil() in the caller so it doesn't gate the response.
 */
export async function touchSession(
  env: Env,
  sessionId: string,
  existing: SessionRecord,
): Promise<void> {
  const updated: SessionRecord = {
    ...existing,
    lastUsedAt: new Date().toISOString(),
  };
  await env.EDGEGAP_MCP_KV.put(KV_PREFIX + sessionId, JSON.stringify(updated), {
    expirationTtl: 60 * 60 * 24 * 90,
  });
}

/** Delete a session — user-initiated disconnect. */
export async function deleteSession(
  env: Env,
  sessionId: string,
): Promise<void> {
  await env.EDGEGAP_MCP_KV.delete(KV_PREFIX + sessionId);
}
