/**
 * MCP Resources. All resources are read-only data fetches against Edgegap,
 * so they're available in both read-only and full scope.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EdgegapClient } from "../lib/client.js";
import { loadRegistry } from "../lib/spec.js";

export function registerResources(server: McpServer, client: EdgegapClient): void {
  server.registerResource(
    "apps",
    "edgegap://apps",
    {
      title: "Applications catalog",
      description: "All applications in this Edgegap organization.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/apps",
        query: { limit: 100 },
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "deployments",
    "edgegap://deployments",
    {
      title: "Active deployments",
      description: "Currently running deployments.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/deployments",
        query: { limit: 100 },
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "locations",
    "edgegap://locations",
    {
      title: "Edgegap locations",
      description: "All Edgegap edge locations.",
      mimeType: "application/json",
    },
    async (uri) => {
      const data = await client.requestOrThrow({
        method: "GET",
        path: "/v1/locations",
      });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "api-catalog",
    "edgegap://api-catalog",
    {
      title: "Edgegap API operation catalog",
      description:
        "All operationIds from the bundled OpenAPI spec, grouped by tag. Static, no API call.",
      mimeType: "application/json",
    },
    async (uri) => {
      const reg = loadRegistry();
      const byTag: Record<string, Array<{ operationId: string; method: string; path: string; summary?: string }>> = {};
      for (const ep of reg.all) {
        const tag = ep.tags[0] ?? "Untagged";
        if (!byTag[tag]) byTag[tag] = [];
        byTag[tag].push({
          operationId: ep.operationId,
          method: ep.method,
          path: ep.path,
          summary: ep.summary,
        });
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { total_operations: reg.all.length, by_tag: byTag },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
