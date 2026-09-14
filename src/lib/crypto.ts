/**
 * Cryptographic helpers.
 *
 * Uses Web Crypto API (built into Workers — no dependencies).
 *
 * Two use cases:
 *   1. Encrypt user API tokens before storing in KV. AES-GCM with a per-record
 *      random IV; the encryption key is a Worker secret shared across all sessions.
 *   2. HMAC-sign session IDs so we can verify a session cookie or paste-token
 *      wasn't tampered with, without storing a separate lookup table for it.
 */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64UrlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars)");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function importHmacKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Encrypt a plaintext string with AES-GCM. Returns a single base64url string
 * containing IV || ciphertext (12-byte IV prepended). Storing IV+ciphertext
 * together keeps KV records to a single value with no schema gymnastics.
 */
export async function encryptToken(
  plaintext: string,
  hexKey: string,
): Promise<string> {
  const key = await importAesKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return bytesToB64Url(combined);
}

export async function decryptToken(
  encoded: string,
  hexKey: string,
): Promise<string> {
  const key = await importAesKey(hexKey);
  const combined = b64UrlToBytes(encoded);
  const iv = combined.subarray(0, 12);
  const ct = combined.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/**
 * HMAC-sign a string and return a compact "<value>.<sig>" token.
 *
 * Used for session identifiers passed through cookies or Authorization headers.
 * The Worker can verify the token wasn't tampered with by re-computing the HMAC
 * and constant-time-comparing the signature.
 */
export async function signValue(
  value: string,
  hexKey: string,
): Promise<string> {
  const key = await importHmacKey(hexKey);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  return `${value}.${bytesToB64Url(sig)}`;
}

export async function verifySignedValue(
  signed: string,
  hexKey: string,
): Promise<string | null> {
  const lastDot = signed.lastIndexOf(".");
  if (lastDot < 1) return null;
  const value = signed.slice(0, lastDot);
  const sigEncoded = signed.slice(lastDot + 1);
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64UrlToBytes(sigEncoded);
  } catch {
    return null;
  }
  const key = await importHmacKey(hexKey);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(value),
  );
  return ok ? value : null;
}

/** Generate a fresh opaque session ID. 32 bytes of random = plenty of entropy. */
export function generateSessionId(): string {
  return bytesToB64Url(crypto.getRandomValues(new Uint8Array(32)));
}
