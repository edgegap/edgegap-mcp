/**
 * PostHog product analytics for the hosted endpoint (mcp.edgegap.dev) only.
 *
 * The local server (npx @edgegap/mcp) and the self-hosted Docker image never
 * load this file: they run on customers' machines and send nothing but the API
 * calls themselves. This runs on Edgegap's own Worker.
 *
 * WHAT IS SENT, EXHAUSTIVELY (allowlisted per event, never tool arguments):
 *   - mcp_initialize:     MCP client name/version, protocol version
 *   - mcp_tool_call:      tool name, success, Edgegap API status on failure,
 *                         duration, dry_run, and the skill name for get_skill
 *   - mcp_prompt_get:     the prompt (skill) name
 *   - mcp_resource_read:  the skill resource path (edgegap-skill:// only)
 *   - on every event:     server version, read-only flag, whether a token was
 *                         present, Cloudflare's country code, HTTP User-Agent
 *
 * NEVER SENT: the API token, tool arguments (IPs, env vars, image names, app
 * names), results, error text, or the client IP — GeoIP is disabled and the
 * country comes from Cloudflare.
 *
 * Identity: distinct_id is an HMAC-SHA256 of the API token keyed with the
 * TELEMETRY_SALT secret, so events from one organization's token group
 * together without the token being recoverable. Without the salt, or without
 * a token, events are anonymous and create no person profile.
 *
 * Off unless POSTHOG_API_KEY is set. A client can opt out of any request with
 * the header "X-Edgegap-Telemetry: off" (or "DNT: 1").
 *
 * Every send goes through ctx.waitUntil with a short timeout and swallows
 * errors: analytics must never delay or break an MCP response.
 */

import type { ToolCallEvent } from '../src/tools.js';

export interface TelemetryEnv {
  /** PostHog project API key. Telemetry is off when unset. Set as a secret. */
  POSTHOG_API_KEY?: string;
  /** "https://us.i.posthog.com" (default) or "https://eu.i.posthog.com". */
  POSTHOG_HOST?: string;
  /** Secret key for hashing tokens into distinct_ids. Anonymous when unset. */
  TELEMETRY_SALT?: string;
}

export interface Telemetry {
  /** Records MCP-level events from the JSON-RPC request body. */
  observeRpc(body: unknown): void;
  /** Hook for registerTools: records each tool call's outcome. */
  toolCall(event: ToolCallEvent): void;
}

interface Context {
  serverVersion: string;
  readOnly: boolean;
  token: string | undefined;
}

const SEND_TIMEOUT_MS = 3000;

async function hmac(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function optedOut(request: Request): boolean {
  const flag = request.headers.get('X-Edgegap-Telemetry')?.trim().toLowerCase();
  return flag === 'off' || flag === '0' || flag === 'false' || request.headers.get('DNT') === '1';
}

const short = (v: unknown, max = 120) => (typeof v === 'string' ? v.slice(0, max) : undefined);

export function createTelemetry(
  env: TelemetryEnv,
  request: Request,
  ctx: ExecutionContext,
  context: Context
): Telemetry | undefined {
  const apiKey = env.POSTHOG_API_KEY?.trim();
  if (!apiKey || optedOut(request)) return undefined;
  const host = (env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com').replace(/\/+$/, '');

  // One id per request when anonymous; derived from the token otherwise.
  const salt = env.TELEMETRY_SALT?.trim();
  const identity: Promise<{ id: string; person: boolean }> =
    context.token && salt
      ? hmac(salt, context.token).then((h) => ({ id: `org_${h}`, person: true }))
      : Promise.resolve({ id: `anon_${crypto.randomUUID()}`, person: false });

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const common = {
    server_version: context.serverVersion,
    transport: 'hosted',
    read_only: context.readOnly,
    has_token: Boolean(context.token),
    country: cf?.country,
    user_agent: short(request.headers.get('User-Agent')),
    $geoip_disable: true,
    $lib: 'edgegap-mcp-worker',
  };

  const capture = (event: string, properties: Record<string, unknown>) => {
    const timestamp = new Date().toISOString();
    ctx.waitUntil(
      (async () => {
        try {
          const { id, person } = await identity;
          await fetch(`${host}/i/v0/e/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: apiKey,
              event,
              distinct_id: id,
              timestamp,
              properties: { ...common, ...properties, ...(person ? {} : { $process_person_profile: false }) },
            }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          });
        } catch {
          // Analytics is best-effort. Never surface it.
        }
      })()
    );
  };

  return {
    observeRpc(body) {
      for (const msg of Array.isArray(body) ? body : [body]) {
        if (!msg || typeof msg !== 'object') continue;
        const { method, params } = msg as { method?: string; params?: Record<string, unknown> };
        if (method === 'initialize') {
          const client = (params?.clientInfo ?? {}) as { name?: unknown; version?: unknown };
          capture('mcp_initialize', {
            client_name: short(client.name, 80),
            client_version: short(client.version, 40),
            protocol_version: short(params?.protocolVersion, 20),
          });
        } else if (method === 'prompts/get') {
          capture('mcp_prompt_get', { prompt: short(params?.name, 80) });
        } else if (method === 'resources/read') {
          const uri = short(params?.uri, 200) ?? '';
          // Skill files are public content; any other URI is reported only as "other".
          capture('mcp_resource_read', { resource: uri.startsWith('edgegap-skill://') ? uri : 'other' });
        }
      }
    },
    toolCall(e) {
      capture('mcp_tool_call', { ...e });
    },
  };
}
