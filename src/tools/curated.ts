/**
 * Curated MCP tools.
 *
 * Each tool declares `kind: "read" | "mutate"`. The registration function takes
 * the active scope ("read" or "full") and skips mutating tools when scope is
 * read-only. This means in read-only mode the model never SEES the destructive
 * tools — they're not just gated at handler time.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EdgegapClient, EdgegapError } from "../lib/client.js";
import type { AccessScope } from "../lib/sessions.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function wrap<T>(
  handler: (input: T) => Promise<ToolResult>,
): (input: T) => Promise<ToolResult> {
  return async (input: T) => {
    try {
      return await handler(input);
    } catch (err) {
      if (err instanceof EdgegapError) {
        return {
          content: [
            {
              type: "text",
              text: `Edgegap API error ${err.status} on ${err.path}\n\n${
                typeof err.body === "string"
                  ? err.body
                  : JSON.stringify(err.body, null, 2)
              }`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  };
}

export function registerCuratedTools(
  server: McpServer,
  client: EdgegapClient,
  scope: AccessScope,
): void {
  const fullAccess = scope === "full";

  // -------------------- READ-ONLY TOOLS (always registered) --------------------

  server.registerTool(
    "list_apps",
    {
      title: "List applications",
      description:
        "List all applications (games) registered in this Edgegap organization. Returns app names, versions, and basic metadata.",
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    wrap(async ({ page, limit }) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/apps",
        query: { page, limit },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "get_app",
    {
      title: "Get application details",
      description:
        "Get the configuration and metadata for a single application by name, including its list of versions.",
      inputSchema: { app_name: z.string() },
    },
    wrap(async ({ app_name }) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: `/v1/app/${encodeURIComponent(app_name)}`,
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "list_app_versions",
    {
      title: "List app versions",
      description:
        "List all versions of a specific application. Each version is a deployable container image configuration.",
      inputSchema: { app_name: z.string() },
    },
    wrap(async ({ app_name }) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: `/v1/app/${encodeURIComponent(app_name)}/versions`,
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "get_deployment_status",
    {
      title: "Get deployment status",
      description:
        "Get current status, public endpoint, and lifecycle info for a deployment. Poll after deploy_server until status is READY. Rate limit: 20 req/sec.",
      inputSchema: { request_id: z.string() },
    },
    wrap(async ({ request_id }) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: `/v1/status/${encodeURIComponent(request_id)}`,
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "list_deployments",
    {
      title: "List active deployments",
      description:
        "List all currently active deployments in this organization. Useful for audits or finding orphan deployments.",
      inputSchema: {
        app_name: z.string().optional(),
        version_name: z.string().optional(),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    wrap(async ({ app_name, version_name, page, limit }) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/deployments",
        query: { app_name, version_name, page, limit },
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "list_locations",
    {
      title: "List Edgegap locations",
      description:
        "List all Edgegap edge locations (cities/regions) where deployments can be placed.",
      inputSchema: {},
    },
    wrap(async () => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/locations",
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "list_beacons",
    {
      title: "List ping beacons",
      description:
        "List active ping beacons. Game clients ping these to measure latency to each region.",
      inputSchema: {},
    },
    wrap(async () => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/locations/beacons",
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "get_relay_session",
    {
      title: "Get relay session details",
      description:
        "Retrieve an Edgegap relay session by ID. Calls GET /v1/relays/sessions/{session_id}. " +
        "Relays are for client-to-client communication through Edgegap's edge — see create_relay_session. " +
        "Note: 'session' in the Edgegap API only refers to relay sessions; there is no general-purpose " +
        "matchmaking-session resource. For deployments, use get_deployment_status instead.",
      inputSchema: { session_id: z.string() },
    },
    wrap(async ({ session_id }) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: `/v1/relays/sessions/${encodeURIComponent(session_id)}`,
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "search_endpoints",
    {
      title: "Search Edgegap API endpoints",
      description:
        "Search the Edgegap OpenAPI spec for endpoints matching a keyword. Returns operationIds invokable via edgegap_call.",
      inputSchema: { query: z.string() },
    },
    wrap(async ({ query }) => {
      const { loadRegistry, summarizeEndpoint, isMutating } = await import(
        "../lib/spec.js"
      );
      const reg = loadRegistry();
      const q = query.toLowerCase();
      const matches = reg.all
        .filter(
          (ep) =>
            ep.operationId.toLowerCase().includes(q) ||
            ep.path.toLowerCase().includes(q) ||
            (ep.summary?.toLowerCase().includes(q) ?? false) ||
            ep.tags.some((t) => t.toLowerCase().includes(q)),
        )
        // In read-only mode, hide mutating endpoints from search too —
        // otherwise the model finds them and tries edgegap_call only to be denied.
        .filter((ep) => fullAccess || !isMutating(ep))
        .slice(0, 25)
        .map((ep) => ({
          operationId: ep.operationId,
          tags: ep.tags,
          mutates: isMutating(ep),
          signature: summarizeEndpoint(ep),
        }));
      return jsonResult({
        query,
        scope,
        match_count: matches.length,
        results: matches,
        hint: fullAccess
          ? "Invoke any of these via edgegap_call with its operationId."
          : "Read-only session: mutating endpoints are hidden. Reconnect with /mcp/full for write access.",
      });
    }),
  );

  // -------------------- MUTATING TOOLS (only when scope === "full") --------------------

  if (!fullAccess) return;

  server.registerTool(
    "deploy_server",
    {
      title: "Deploy a game server",
      description:
        "Deploy a new game server instance using the Edgegap v2 deployment API. " +
        "Use this when the user asks to 'deploy', 'spin up', 'launch', 'start', or 'host' a server. " +
        "REQUIRES at least one user (IP address or geo coordinates) — Edgegap uses these to pick " +
        "the optimal edge location. If the user doesn't provide a player IP, ask them, or fall back " +
        "to a geo coordinate that makes sense for their region. " +
        "Returns a deployment object with a request_id. ALWAYS follow up by polling get_deployment_status " +
        "with that request_id until status is 'Status.READY' or terminal. " +
        "Each call creates a billable deployment — confirm with the user before deploying multiple servers in one turn.",
      inputSchema: {
        application: z.string()
          .describe("Application name (NOT app_name — the v2 API field is 'application'). Use list_apps if you don't know it."),
        version: z.string()
          .describe("Version name within the application. Use list_app_versions to discover. If the user doesn't specify, pick the most recent."),
        users: z
          .array(
            z.discriminatedUnion("user_type", [
              z.object({
                user_type: z.literal("ip_address"),
                user_data: z.object({ ip_address: z.string() }),
              }),
              z.object({
                user_type: z.literal("geo_coordinates"),
                user_data: z.object({
                  latitude: z.number(),
                  longitude: z.number(),
                }),
              }),
            ]),
          )
          .min(1)
          .describe(
            "REQUIRED: at least one user. Each entry is either " +
              "{user_type: 'ip_address', user_data: {ip_address: '203.0.113.45'}} or " +
              "{user_type: 'geo_coordinates', user_data: {latitude: 45.5, longitude: -73.5}}.",
          ),
        environment_variables: z
          .array(
            z.object({
              key: z.string(),
              value: z.string(),
              is_hidden: z.boolean()
                .describe("Required by API. Set true to hide the value in the Edgegap dashboard UI."),
            }),
          )
          .optional()
          .describe("Optional. Note: is_hidden is REQUIRED on each entry (not optional)."),
        tags: z.array(z.string()).optional(),
        webhook_on_ready: z
          .object({ url: z.string().url() })
          .optional()
          .describe("Optional. Webhook called when deployment becomes ready."),
        webhook_on_error: z.object({ url: z.string().url() }).optional(),
        webhook_on_terminated: z.object({ url: z.string().url() }).optional(),
        require_cached_locations: z.boolean().optional()
          .describe("If true, only deploy to locations that already have the image cached (faster, fewer location options)."),
      },
    },
    wrap(async (input) => {
      // Field names here EXACTLY match the v2 DeploymentCreate schema.
      // Bug history: an earlier version used v1 names (app_name/version_name/ip_list)
      // which the v2 endpoint silently rejects with a confusing error.
      const body: Record<string, unknown> = {
        application: input.application,
        version: input.version,
        users: input.users,
      };
      if (input.environment_variables) {
        body.environment_variables = input.environment_variables;
      }
      if (input.tags) body.tags = input.tags;
      if (input.webhook_on_ready) body.webhook_on_ready = input.webhook_on_ready;
      if (input.webhook_on_error) body.webhook_on_error = input.webhook_on_error;
      if (input.webhook_on_terminated) {
        body.webhook_on_terminated = input.webhook_on_terminated;
      }
      if (input.require_cached_locations !== undefined) {
        body.require_cached_locations = input.require_cached_locations;
      }
      const data = await client.requestOrThrow({
        method: "POST",
        path: "/v2/deployments",
        body,
      });
      return jsonResult({
        result: data,
        _next_step:
          "Deployment requested. Now poll get_deployment_status with the request_id " +
          "every 3-5 seconds until current_status is 'Status.READY' (success) or one of " +
          "'Status.ERROR' / 'Status.TERMINATED' (failure). Report the host:port to the user once ready.",
      });
    }),
  );

  server.registerTool(
    "stop_deployment",
    {
      title: "Stop a deployment",
      description:
        "Stop and tear down a running deployment. IRREVERSIBLE — connected players will be disconnected.",
      inputSchema: { request_id: z.string() },
    },
    wrap(async ({ request_id }) => {
      const data = await client.requestOrThrow({
        method: "DELETE",
        path: `/v1/stop/${encodeURIComponent(request_id)}`,
      });
      return jsonResult(data);
    }),
  );

  server.registerTool(
    "create_relay_session",
    {
      title: "Create a relay session",
      description:
        "Create an Edgegap relay session. Relays let game clients communicate through an Edgegap edge node " +
        "instead of connecting peer-to-peer or to a dedicated server — useful for NAT-punchthrough fallback, " +
        "low-latency P2P, and games without dedicated servers. " +
        "This calls POST /v1/relays/sessions. Returns a session_id used to authorize users via " +
        "relay-user-authorize (use edgegap_call for that — there's no curated tool for it yet).",
      inputSchema: {
        // Use a permissive body shape since the relay-session schema has options we
        // don't want to enumerate in detail here — the user/model can pass extras through.
        // Fields below cover the common case; anything else can be added by the model
        // and will pass through to the API.
        location: z.string().optional()
          .describe("Edgegap location code (e.g. 'lim'). If omitted, Edgegap picks one. Use list_locations to discover."),
        tags: z.array(z.string()).optional(),
        webhook_url: z.string().url().optional()
          .describe("Webhook called on session lifecycle events."),
      },
    },
    wrap(async (input) => {
      const body: Record<string, unknown> = {};
      if (input.location) body.location = input.location;
      if (input.tags) body.tags = input.tags;
      if (input.webhook_url) body.webhook_url = input.webhook_url;
      const data = await client.requestOrThrow({
        method: "POST",
        path: "/v1/relays/sessions",
        body,
      });
      return jsonResult(data);
    }),
  );
}
