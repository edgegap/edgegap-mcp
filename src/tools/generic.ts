/**
 * Generic edgegap_call tool — covers the full API surface.
 *
 * Read-only enforcement happens here too: even if the model somehow learns
 * an operationId for a mutating endpoint, it's blocked unless scope === "full".
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EdgegapClient } from "../lib/client.js";
import { loadRegistry, renderPath, summarizeEndpoint, isMutating } from "../lib/spec.js";
import type { AccessScope } from "../lib/sessions.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function registerGenericTool(
  server: McpServer,
  client: EdgegapClient,
  scope: AccessScope,
): void {
  const fullAccess = scope === "full";

  server.registerTool(
    "edgegap_call",
    {
      title: "Call any Edgegap API endpoint",
      description:
        (fullAccess
          ? "Invoke any Edgegap API operation by operationId. Use search_endpoints first to discover the right operationId and parameters. Covers the full ~50-endpoint public API. "
          : "Invoke any READ-ONLY Edgegap API operation by operationId. Mutating endpoints (POST/PUT/PATCH/DELETE) are blocked in this read-only session. ") +
        "IMPORTANT: when an operation needs a JSON body, pass `body` as a structured object " +
        '(e.g. {"application": "myapp", "version": "v1", "users": [...]}), NOT as a stringified JSON. ' +
        "The tool will pass your object straight through to the API.",
      inputSchema: {
        operationId: z.string()
          .describe("The OpenAPI operationId. Discover via search_endpoints first."),
        path_params: z.record(z.union([z.string(), z.number()])).optional()
          .describe("Path parameters to substitute into the URL template, e.g. {\"app_name\": \"myapp\"}."),
        query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe("Query string parameters."),
        // Why z.record(z.any()) instead of z.unknown():
        // z.unknown() serializes to an empty JSON-Schema {}, which gives the model no
        // hint about the expected shape. The model then often sends body as a JSON
        // STRING (e.g. body: "{\"foo\":1}") instead of a JSON OBJECT — and the HTTP
        // client double-stringifies it. z.record(z.any()) serializes to type:object,
        // which clearly tells the model "send a JSON object, not a string".
        // We ALSO defensively re-parse string bodies in the handler below for safety.
        body: z.record(z.any()).optional()
          .describe(
            "JSON object request body for POST/PUT/PATCH operations. " +
              "MUST be passed as a structured object, not as a stringified JSON. " +
              "Example: {\"application\": \"my-game\", \"version\": \"v1\", \"users\": [...]}",
          ),
      },
    },
    async (input) => {
      try {
        const reg = loadRegistry();
        const ep = reg.byId.get(input.operationId);
        if (!ep) {
          const q = input.operationId.toLowerCase();
          const suggestions = reg.all
            .filter((e) =>
              e.operationId.toLowerCase().includes(q.split("-")[0] ?? q),
            )
            .filter((e) => fullAccess || !isMutating(e))
            .slice(0, 5)
            .map((e) => e.operationId);
          return errorResult(
            `Unknown operationId: "${input.operationId}".\n\n` +
              (suggestions.length
                ? `Did you mean:\n  - ${suggestions.join("\n  - ")}\n`
                : "") +
              `Use search_endpoints to browse.`,
          );
        }

        if (!fullAccess && isMutating(ep)) {
          return errorResult(
            `Operation "${ep.operationId}" (${ep.method} ${ep.path}) is a mutating ` +
              `endpoint and is blocked in this read-only session.\n\n` +
              `To enable write access, reconnect this MCP server at ${"/mcp/full"} ` +
              `instead of ${"/mcp"}.`,
          );
        }

        const pathParams = (input.path_params ?? {}) as Record<
          string,
          string | number
        >;
        const required = ep.params
          .filter((p) => p.in === "path" && p.required)
          .map((p) => p.name);
        const missing = required.filter((n) => pathParams[n] === undefined);
        if (missing.length) {
          return errorResult(
            `Missing required path parameter(s): ${missing.join(", ")}\n\n` +
              `Endpoint: ${summarizeEndpoint(ep)}`,
          );
        }

        const resolvedPath = renderPath(ep.path, pathParams);

        // Defensive body coercion. Even with a tightened schema, models still
        // occasionally pass body as a JSON string. Detect and re-parse so we send
        // a real object to Edgegap instead of a double-stringified string. If parsing
        // fails, surface a clear error rather than silently sending garbage.
        let coercedBody: unknown = input.body;
        if (typeof coercedBody === "string") {
          const trimmed = coercedBody.trim();
          if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
              coercedBody = JSON.parse(trimmed);
            } catch (e) {
              return errorResult(
                `The 'body' parameter looks like JSON-as-a-string but failed to parse: ` +
                  `${e instanceof Error ? e.message : String(e)}\n\n` +
                  `Pass body as a structured JSON object, not a string. Example: ` +
                  `{"application":"myapp","version":"v1","users":[{"user_type":"ip_address","user_data":{"ip_address":"1.2.3.4"}}]}`,
              );
            }
          }
        }

        const res = await client.request({
          method: ep.method,
          path: resolvedPath,
          query: input.query as Record<string, string | number | boolean | undefined> | undefined,
          body: coercedBody,
        });

        return jsonResult({
          operationId: ep.operationId,
          request: { method: ep.method, path: resolvedPath },
          response: { status: res.status, ok: res.ok, body: res.data },
        });
      } catch (err) {
        return errorResult(
          `edgegap_call failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  );
}
