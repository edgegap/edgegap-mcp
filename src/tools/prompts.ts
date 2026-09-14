/**
 * MCP Prompts — workflow templates.
 *
 * Most prompts orchestrate mutating tools, so they're scope-gated like the
 * tools themselves. Read-only sessions get only audit/diagnostic prompts.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessScope } from "../lib/sessions.js";

export function registerPrompts(server: McpServer, scope: AccessScope): void {
  // Available in all scopes — read-only ops.
  server.registerPrompt(
    "diagnose_deployment",
    {
      title: "Diagnose a deployment",
      description: "Investigate why a deployment is failing or stuck.",
      argsSchema: { request_id: z.string() },
    },
    ({ request_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Diagnose deployment ${request_id}.`,
              ``,
              `1. Fetch get_deployment_status; check status and any error fields.`,
              `2. Look up its tags via search_endpoints("deployment-tag") if relevant.`,
              `3. If failed, explain the likely cause (image pull, port, env, resources).`,
              `4. Recommend a next action.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "audit_active_deployments",
    {
      title: "Audit active deployments",
      description: "Review active deployments for cost or capacity issues.",
      argsSchema: {},
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Audit my active deployments on Edgegap.`,
              ``,
              `1. Call list_deployments to get the full set.`,
              `2. Group by app and location.`,
              `3. Flag idle (old start time) or duplicated deployments.`,
              `4. Recommend which to stop and list their request_ids — DON'T stop them; wait for my confirmation.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  // Full-scope only — these orchestrate mutating tools.
  if (scope !== "full") return;

  server.registerPrompt(
    "deploy_build",
    {
      title: "Deploy a build",
      description:
        "Deploy a specific app version, picking a location from player IPs, and verify it comes online.",
      argsSchema: {
        app_name: z.string(),
        version_name: z.string().optional(),
        player_ips: z.string().optional(),
      },
    },
    ({ app_name, version_name, player_ips }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Deploy on Edgegap.`,
              ``,
              `App: ${app_name}`,
              version_name ? `Version: ${version_name}` : `Version: default`,
              player_ips
                ? `Player IPs: ${player_ips}`
                : `No player IPs — use a sensible default location.`,
              ``,
              `1. Confirm app/version exists.`,
              `2. Call deploy_server.`,
              `3. Poll get_deployment_status until READY or terminal.`,
              `4. Report host:port and total deploy time.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "set_up_app",
    {
      title: "Set up a new app",
      description: "Onboard a new application onto Edgegap.",
      argsSchema: {
        app_name: z.string(),
        image: z.string(),
        port: z.string(),
        protocol: z.string().optional(),
      },
    },
    ({ app_name, image, port, protocol }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Set up a new Edgegap app named "${app_name}".`,
              ``,
              `Image: ${image}`,
              `Port: ${port}`,
              `Protocol: ${protocol ?? "UDP"}`,
              ``,
              `1. Use search_endpoints to find application-create and application-version-create.`,
              `2. Use edgegap_call to create the app and initial version.`,
              `3. Confirm with get_app.`,
              `4. Suggest the next step.`,
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
