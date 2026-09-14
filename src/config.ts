/**
 * Configuration and safety gates.
 *
 * Everything here exists to keep the blast radius of an autonomous agent small.
 * The Edgegap API token is org-wide, so the server layers its own limits on top.
 */

export interface Config {
  /** Token from the environment, if supplied. Absent means "ask the developer". */
  envToken?: string;
  baseUrlV1: string;
  baseUrlV2: string;
  /** When true, every mutating tool is hidden from the agent entirely. */
  readOnly: boolean;
  /** If non-empty, tools refuse to touch applications outside this list. */
  appAllowlist: string[];
  /** Ceiling on max_duration (minutes) the agent may request. */
  maxDurationCeiling: number;
  /** Timeout for a single HTTP call, ms. */
  requestTimeoutMs: number;
}

export class ConfigError extends Error {}

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  // A token in the environment is optional. When it is absent the server asks
  // the developer for one at first use, which removes the "configure before
  // anything works" step that loses people during onboarding.
  const raw = env.EDGEGAP_API_TOKEN?.trim();

  // Tokens are pasted by hand often enough that it is worth catching the
  // common mistake of including the "token " prefix twice.
  const envToken = raw ? raw.replace(/^token\s+/i, '') : undefined;

  return {
    envToken,
    baseUrlV1: env.EDGEGAP_BASE_URL?.trim() || 'https://api.edgegap.com',
    baseUrlV2:
      (env.EDGEGAP_BASE_URL?.trim() || 'https://api.edgegap.com') + '/v2',
    readOnly: env.EDGEGAP_READ_ONLY === '1' || env.EDGEGAP_READ_ONLY === 'true',
    appAllowlist: parseList(env.EDGEGAP_APP_ALLOWLIST),
    maxDurationCeiling: parseIntEnv(env.EDGEGAP_MAX_DURATION_MINUTES, 60),
    requestTimeoutMs: parseIntEnv(env.EDGEGAP_TIMEOUT_MS, 30_000),
  };
}

/**
 * Throws if the agent is reaching for an application it was not scoped to.
 * No allowlist configured means no restriction.
 */
export function assertAppAllowed(config: Config, appName: string): void {
  if (config.appAllowlist.length === 0) return;
  if (!config.appAllowlist.includes(appName)) {
    throw new Error(
      `Application "${appName}" is not in EDGEGAP_APP_ALLOWLIST. ` +
        `Allowed: ${config.appAllowlist.join(', ')}. ` +
        `This server is scoped deliberately; ask the human to widen the ` +
        `allowlist rather than trying another application name.`
    );
  }
}

/**
 * Strips the live token out of text before it reaches the model.
 * Error strings from HTTP layers sometimes echo request headers back.
 */
export function redact(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('<redacted-token>');
}
