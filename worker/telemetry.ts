/**
 * PostHog MCP Analytics for the hosted endpoint (mcp.edgegap.dev) only, using
 * PostHog's official MCP SDK (@posthog/mcp) on top of posthog-node.
 *
 * The local server (npx @edgegap/mcp) and the self-hosted Docker image never
 * load this file: they run on customers' machines and send nothing but the API
 * calls themselves. Both packages are devDependencies, bundled into the Worker
 * only.
 *
 * WHAT IS SENT. The SDK's events — $mcp_initialize, $mcp_tools_list,
 * $mcp_tool_call, $mcp_resources_list, $mcp_resource_read — filtered through
 * an ALLOWLIST (beforeSend below): only metadata properties pass. Tool name,
 * duration, error flag and category, MCP client and protocol, argument NAMES,
 * which tools were listed, and which skill resource was read. Plus ours: which
 * skill edgegap_get_skill loaded, dry_run, read-only, whether a token was
 * present and, when not, why (auth_problem: "absent" for no header, "foreign"
 * for a bearer the MCP client issued itself), Cloudflare's country code, on a
 * failed call a fixed error_cause label (errorCause below; the text it is read
 * from is then dropped), and probe: true for known MCP scanners. Skill
 * prompt use is captured separately as $mcp_prompt_get, since the TypeScript
 * SDK does not track prompts.
 *
 * NEVER SENT. The API token. Tool argument values ($mcp_parameters: player IPs,
 * env vars, app and image names, registry credentials), tool responses
 * ($mcp_response), error text ($mcp_error_message, $exception), and anything a
 * future SDK version adds: a property is dropped unless it is named below.
 * GeoIP is off; the country comes from Cloudflare.
 *
 * AGENT FIELDS. The SDK can add `context`, `conversation_id` and `llm_model`
 * parameters to every tool, so agents state their intent and correlate calls.
 * That changes every tool's input schema and records free text written by the
 * agent, so it is OFF unless POSTHOG_AGENT_FIELDS is "1".
 *
 * IDENTITY. distinct_id is org_ + HMAC-SHA256(token, TELEMETRY_SALT): one
 * organization's events group together, and the token cannot be recovered.
 * With no token or no salt, sessions are anonymous (no person profile).
 *
 * Off unless POSTHOG_API_KEY is set. A client can opt out of any request with
 * "X-Edgegap-Telemetry: off" (or "DNT: 1"). Events are flushed through
 * ctx.waitUntil, so analytics never delays or breaks an MCP response.
 */

import { PostHog } from 'posthog-node';
import { instrument } from '@posthog/mcp';
import type { BeforeSendFn, MCPAnalyticsOptions } from '@posthog/mcp';
import type { McpServer as McpServerV1 } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface TelemetryEnv {
  /** PostHog project API key (phc_...). Analytics is off when unset. Set as a secret. */
  POSTHOG_API_KEY?: string;
  /** "https://us.i.posthog.com" (default) or "https://eu.i.posthog.com". */
  POSTHOG_HOST?: string;
  /** Secret key for hashing tokens into distinct_ids. Anonymous when unset. */
  TELEMETRY_SALT?: string;
  /** "1" lets the SDK add context, conversation_id and llm_model parameters to every tool. */
  POSTHOG_AGENT_FIELDS?: string;
}

export interface Analytics {
  /** Instruments one per-request MCP server. Call after its tools are registered. */
  instrument(server: unknown): void;
  /** Records skill prompt reads from the JSON-RPC body; the TS SDK has no prompt event. */
  observeRpc(body: unknown): void;
  /** Sends queued events after the response, without delaying it. */
  flush(): void;
}

/** How long after the response to flush; see Analytics.flush. */
const FLUSH_DELAY_MS = 250;

/** SDK events allowed out. Anything else, including $exception, is dropped. */
const EVENTS = new Set([
  '$mcp_initialize',
  '$mcp_tools_list',
  '$mcp_tool_call',
  '$mcp_resources_list',
  '$mcp_resource_read',
  '$mcp_prompt_get',
  '$identify',
]);

/** Metadata properties allowed out. Everything not named here is dropped. */
const PROPERTIES = new Set([
  '$session_id', '$process_person_profile', '$groups', '$lib', '$lib_version', '$geoip_disable',
  '$mcp_source', '$mcp_protocol_version', '$mcp_client_name', '$mcp_client_version',
  '$mcp_vendor_client', '$mcp_client_user_agent', '$mcp_server_name', '$mcp_server_version',
  '$mcp_server_build', '$mcp_tool_name', '$mcp_tool_category', '$mcp_duration_ms',
  '$mcp_is_error', '$mcp_error_type', '$mcp_input_keys', '$mcp_input_aliases_used',
  '$mcp_listed_tool_names', '$mcp_resource_name',
  // Ours, from eventProperties.
  'read_only', 'has_token', 'auth_problem', 'country', 'skill', 'dry_run', 'prompt',
  'error_cause', 'probe',
]);

/**
 * Why a call failed, as one fixed label, so errors can be broken down without
 * sending their text. Read from the error message, which is dropped after.
 * Order matters: the first match wins.
 */
const ERROR_CAUSES: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/No Edgegap API token/, 'token_absent'],
  [/does not contain an Edgegap/, 'token_foreign'],
  [/Edgegap API (\d{3})/, (m) => `api_${m[1]}`],
  [/Input validation error|Invalid arguments for tool/, 'validation'],
  [/Tool \S+ not found/, 'unknown_tool'],
  [/failed with status/, 'deployment_failed'],
  [/timed out after \d+ms/, 'request_timeout'],
  [/Network error calling/, 'network'],
  [/No skill named|is not a file in the/, 'unknown_skill'],
  [/Refused|refused|EDGEGAP_[A-Z_]+/, 'guardrail_refused'],
];

export function errorCause(message: unknown): string {
  if (typeof message !== 'string' || !message) return 'unknown';
  for (const [re, label] of ERROR_CAUSES) {
    const m = message.match(re);
    if (m) return typeof label === 'string' ? label : label(m);
  }
  return 'other';
}

/** MCP scanners and health-check crawlers seen in PostHog. They call tools
 *  without a token or with made-up names; flagged so dashboards can drop them. */
const PROBE_CLIENTS = /^(sentinel-probe|verifymcp-probe|mcp-checkup-prober)$/i;

/** Extra properties when POSTHOG_AGENT_FIELDS is on: the agent-written fields. */
const AGENT_PROPERTIES = ['$mcp_intent', '$mcp_intent_source', '$mcp_llm_model', '$mcp_llm_model_source', '$mcp_conversation_id'];

function allowlist(agentFields: boolean): BeforeSendFn {
  const allowed = new Set([...PROPERTIES, ...(agentFields ? AGENT_PROPERTIES : [])]);
  return (event) => {
    if (!EVENTS.has(event.event)) return null;
    const raw = event.properties ?? {};
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (allowed.has(k)) properties[k] = v;
    }
    if (raw.$mcp_is_error === true) properties.error_cause = errorCause(raw.$mcp_error_message);
    if (typeof raw.$mcp_client_name === 'string' && PROBE_CLIENTS.test(raw.$mcp_client_name)) properties.probe = true;
    // Skill files are public content; any other resource is reported as "other".
    if (typeof properties.$mcp_resource_name === 'string' && !properties.$mcp_resource_name.startsWith('edgegap-skill://')) {
      properties.$mcp_resource_name = 'other';
    }
    properties.$geoip_disable = true;
    return { ...event, properties };
  };
}

async function hmac(key: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function optedOut(request: Request): boolean {
  const flag = request.headers.get('X-Edgegap-Telemetry')?.trim().toLowerCase();
  return flag === 'off' || flag === '0' || flag === 'false' || request.headers.get('DNT') === '1';
}

// One posthog-node client per isolate and key: it is only a queue and a
// fetch, and creating it per request would lose nothing but time.
let shared: { key: string; host: string; client: PostHog } | undefined;
function client(key: string, host: string): PostHog {
  if (!shared || shared.key !== key || shared.host !== host) {
    shared = { key, host, client: new PostHog(key, { host, disableGeoip: true, flushAt: 20, flushInterval: 0 }) };
  }
  return shared.client;
}

export function createAnalytics(
  env: TelemetryEnv,
  request: Request,
  ctx: ExecutionContext,
  context: {
    serverVersion: string;
    readOnly: boolean;
    token: string | undefined;
    /** Why there is no usable token, from extractToken. */
    authProblem?: 'absent' | 'foreign';
  }
): Analytics | undefined {
  const key = env.POSTHOG_API_KEY?.trim();
  if (!key || optedOut(request)) return undefined;
  const host = (env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com').replace(/\/+$/, '');
  const posthog = client(key, host);
  const agentFields = env.POSTHOG_AGENT_FIELDS === '1';

  const salt = env.TELEMETRY_SALT?.trim();
  const distinctId: Promise<string | undefined> =
    context.token && salt ? hmac(salt, context.token).then((h) => `org_${h}`) : Promise.resolve(undefined);
  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  const authProblem = context.token ? undefined : context.authProblem;

  const options: MCPAnalyticsOptions = {
    serverBuild: context.serverVersion,
    context: agentFields,
    enableConversationId: agentFields,
    captureModel: agentFields,
    enableExceptionAutocapture: false,
    identify: async () => {
      const id = await distinctId;
      return id ? { distinctId: id } : null;
    },
    // Facts we choose to add, read from the request without forwarding it.
    eventProperties: (req) => {
      const args = (req?.params?.arguments ?? {}) as Record<string, unknown>;
      return {
        read_only: context.readOnly,
        has_token: Boolean(context.token),
        ...(authProblem ? { auth_problem: authProblem } : {}),
        ...(country ? { country } : {}),
        ...(req?.params?.name === 'edgegap_get_skill' && typeof args.skill === 'string' ? { skill: args.skill.slice(0, 80) } : {}),
        ...(args.dry_run === true ? { dry_run: true } : {}),
      };
    },
    beforeSend: allowlist(agentFields),
  };

  return {
    instrument(server) {
      try {
        instrument(server as McpServerV1, posthog, options);
      } catch {
        // Analytics must never stop the server from serving.
      }
    },
    observeRpc(body) {
      for (const msg of Array.isArray(body) ? body : [body]) {
        const m = msg as { method?: string; params?: { name?: unknown } } | null;
        if (m?.method !== 'prompts/get' || typeof m.params?.name !== 'string') continue;
        const prompt = m.params.name.slice(0, 80);
        ctx.waitUntil(
          distinctId.then((id) => {
            const props = allowlist(agentFields)({
              event: '$mcp_prompt_get',
              distinct_id: id ?? `anon_${crypto.randomUUID()}`,
              properties: { prompt, read_only: context.readOnly, has_token: Boolean(context.token), ...(authProblem ? { auth_problem: authProblem } : {}), country, ...(id ? {} : { $process_person_profile: false }) },
              timestamp: new Date().toISOString(),
              type: 'capture',
            } as Parameters<BeforeSendFn>[0]) as { distinct_id: string; properties: Record<string, unknown> } | null;
            if (!props) return;
            posthog.capture({ distinctId: props.distinct_id, event: '$mcp_prompt_get', properties: props.properties });
            return posthog.flush();
          }).catch(() => {})
        );
      }
    },
    flush() {
      // @posthog/mcp builds each event asynchronously (identify, eventProperties,
      // beforeSend) and only then hands it to posthog-node, without exposing that
      // promise. Flushing as the response returns misses the last call's event,
      // so keep the request alive briefly under waitUntil, then flush. The
      // response is never delayed; the wait is idle time, not CPU.
      ctx.waitUntil(
        new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS))
          .then(() => posthog.flush())
          .catch(() => {})
      );
    },
  };
}
