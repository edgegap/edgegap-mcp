/**
 * The ten golden-path tools.
 *
 * Tool descriptions are written for a coding agent, not a human reading docs.
 * Each one says when to reach for it and what to call next, because the main
 * failure mode in agent flows is not a bad call, it is a call made out of order.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EdgegapClient, EdgegapApiError, DeploymentStatus } from './client.js';
import { Config, assertAppAllowed, redact } from './config.js';
import { TokenSource, TokenUnavailableError } from './auth.js';

/** 1x1 transparent PNG. The create-app endpoint requires an image and agents
 *  have no sensible one to supply; a placeholder beats a blocked flow. */
const PLACEHOLDER_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const TERMINAL_OK = ['READY', 'STATUS_READY'];
const TERMINAL_BAD = ['ERROR', 'STATUS_ERROR', 'TERMINATED', 'STATUS_TERMINATED'];

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown, notice?: string): ToolResult {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: 'text', text: notice ? `${body}\n\nNOTE: ${notice}` : body }],
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Wraps a handler so API errors come back as readable, self-correctable text
 *  rather than a protocol-level exception the agent cannot act on. */
function guard(
  auth: TokenSource,
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  const handled = fn().catch((err: unknown): ToolResult => {
    if (err instanceof TokenUnavailableError) {
      // Not a failure to correct — a decision the human made. Say so plainly
      // so the agent stops rather than looping on the same tool.
      return fail(err.message);
    }
    if (err instanceof EdgegapApiError) {
      const hint = errorHint(err);
      return fail(`${err.message}${hint ? `\n\nLikely cause: ${hint}` : ''}`);
    }
    return fail(redact((err as Error).message ?? String(err), auth.current));
  });

  // The org-wide-scope reminder is attached to whichever call first used a
  // freshly supplied token, success or failure. A developer who just handed
  // over a credential should hear about its blast radius even if the call
  // they were making went on to fail.
  return handled.then((result) => {
    const notice = auth.current ? auth.consumeFirstUseNotice() : undefined;
    if (!notice) return result;
    return {
      ...result,
      content: [...result.content, { type: 'text' as const, text: `NOTE: ${notice}` }],
    };
  });
}

function errorHint(err: EdgegapApiError): string | undefined {
  switch (err.status) {
    case 401:
      return 'the token was rejected. It has been discarded; the next call will ask for a new one.';
    case 404:
      return 'the application or version name does not exist. Call edgegap_list_apps first.';
    case 409:
      return 'a resource with that name already exists. Pick a different name or reuse the existing one.';
    case 422:
      return 'Edgegap could not allocate a server for the requested location or resources. Try different user coordinates, or lower req_cpu/req_memory.';
    case 424:
      return 'Edgegap could not pull the container image. Check docker_repository, docker_image, docker_tag, and registry credentials.';
    default:
      return undefined;
  }
}

/**
 * Builds the count fields for a paginated list.
 *
 * The API's total_count is the total across all pages, not the number of rows
 * returned. Reporting it alone makes a truncated page look complete, and an
 * agent that believes it has the full list will confidently tell a developer
 * their application does not exist. When the page is short, say so and say
 * what to do about it.
 */
function pageInfo(totalCount: number | undefined, returned: number, page: number) {
  const total = totalCount ?? returned;
  if (total <= returned) return { total };
  return {
    total,
    showing: returned,
    truncated: true,
    next_step: `Only page ${page} is shown. Call again with page: ${page + 1} ` +
      `(or raise limit) to see the rest before concluding something is missing.`,
  };
}

/** Trims a deployment status down to what an agent needs to act. */
function compactDeployment(d: DeploymentStatus) {
  const ports = Object.entries(d.ports ?? {}).map(([key, p]) => ({
    name: p.name ?? key,
    connect: p.link,
    external: p.external,
    internal: p.internal,
    protocol: p.protocol,
  }));
  return {
    request_id: d.request_id,
    status: d.current_status,
    running: d.running,
    error: d.error || undefined,
    error_detail: d.error_detail || undefined,
    fqdn: d.fqdn,
    public_ip: d.public_ip,
    application: d.app_name,
    version: d.app_version,
    location: d.location
      ? [d.location.city, d.location.country].filter(Boolean).join(', ')
      : undefined,
    elapsed_seconds: d.elapsed_time,
    ports,
  };
}

const userSchema = z
  .object({
    ip_addresses: z
      .array(z.string())
      .optional()
      .describe('Public IPv4/IPv6 addresses of the players. Edgegap places the server near them.'),
    geo_coordinates: z
      .array(z.object({ latitude: z.number(), longitude: z.number() }))
      .optional()
      .describe('Latitude/longitude pairs, as an alternative to IP addresses.'),
  })
  .describe('Where the players are. Exactly one of these two is required.');

function buildUsers(input: z.infer<typeof userSchema>) {
  const users: Array<{ user_type: string; user_data: Record<string, unknown> }> = [];
  for (const ip of input.ip_addresses ?? []) {
    users.push({ user_type: 'ip_address', user_data: { ip_address: ip } });
  }
  for (const geo of input.geo_coordinates ?? []) {
    users.push({
      user_type: 'geo_coordinates',
      user_data: { latitude: geo.latitude, longitude: geo.longitude },
    });
  }
  return users;
}

export function registerTools(
  server: McpServer,
  client: EdgegapClient,
  config: Config,
  auth: TokenSource
): void {
  const mutating = !config.readOnly;

  // ---------------------------------------------------------------- 1 ----
  server.registerTool(
    'edgegap_list_apps',
    {
      title: 'List Edgegap applications',
      description:
        'List the applications in the Edgegap organization. Start here before creating or ' +
        'deploying anything, so you reuse an existing application instead of making a duplicate. ' +
        'An "application" groups versions of one game server.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Results per page. Default 50.'),
        page: z.number().int().min(1).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, page }) =>
      guard(auth, async () => {
        const res = await client.listApps({ limit: limit ?? 50, page });
        const apps = (res.applications ?? []).map((a) => ({
          name: a.name,
          active: a.is_active,
          last_updated: a.last_updated,
        }));
        return ok({ ...pageInfo(res.total_count, apps.length, page ?? 1), applications: apps });
      })
  );

  // ---------------------------------------------------------------- 2 ----
  if (mutating) {
    server.registerTool(
      'edgegap_create_app',
      {
        title: 'Create an Edgegap application',
        description:
          'Create a new application to hold game server versions. Only call this after ' +
          'edgegap_list_apps confirms no suitable application exists. Creating an application ' +
          'does not deploy anything — follow with edgegap_create_app_version.',
        inputSchema: {
          name: z
            .string()
            .min(3)
            .max(64)
            .describe('Application name, 3-64 chars. Usually the game or project name.'),
          is_active: z.boolean().optional().describe('Whether deployments are allowed. Default true.'),
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ name, is_active }) =>
        guard(auth, async () => {
          assertAppAllowed(config, name);
          const res = await client.createApp({
            name,
            is_active: is_active ?? true,
            image: PLACEHOLDER_IMAGE,
          });
          return ok({
            created: res.name,
            active: res.is_active,
            next_step: 'Call edgegap_create_app_version to attach a container image.',
          });
        })
    );
  }

  // ---------------------------------------------------------------- 3 ----
  server.registerTool(
    'edgegap_list_app_versions',
    {
      title: 'List versions of an application',
      description:
        'List the versions under an application, with their container image and resource ' +
        'settings. Use this to find the version name to deploy, or to copy settings from a ' +
        'working version when creating a new one.',
      inputSchema: {
        application: z.string().describe('Application name, as returned by edgegap_list_apps.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ application }) =>
      guard(auth, async () => {
        assertAppAllowed(config, application);
        const res = await client.listAppVersions(application);
        const versions = (res.versions ?? []).map((v) => ({
          name: v.name,
          active: v.is_active,
          image: [v.docker_repository, v.docker_image, v.docker_tag].filter(Boolean).join('/'),
          cpu_units: v.req_cpu,
          memory_mb: v.req_memory,
          max_duration_minutes: v.max_duration,
          ports: v.ports?.map((p) => `${p.name ?? 'port'}:${p.port}/${p.protocol}`),
        }));
        return ok({ application, ...pageInfo(res.total_count, versions.length, 1), versions });
      })
  );

  // ---------------------------------------------------------------- 4 ----
  if (mutating) {
    server.registerTool(
      'edgegap_create_app_version',
      {
        title: 'Create an application version',
        description:
          'Register a container image as a deployable version of an application. The image must ' +
          'already be pushed to a registry that Edgegap can pull from. Resource units: 1024 cpu ' +
          'units = 1 vCPU; memory_mb must be at least 256 and at most double the cpu units. ' +
          'Set verify_image true on the first version so a bad image fails here rather than at ' +
          'deploy time. Avoid the "latest" docker tag — use a build ID so deployments are reproducible.',
        inputSchema: {
          application: z.string().describe('Existing application name.'),
          name: z
            .string()
            .min(1)
            .max(64)
            .describe('Version identifier, typically a build ID or timestamp.'),
          docker_repository: z
            .string()
            .describe('Registry host, e.g. "docker.io" or "registry.edgegap.com".'),
          docker_image: z.string().describe('Namespaced image, e.g. "mystudio/game-server".'),
          docker_tag: z.string().describe('Image tag. Use a build ID, not "latest".'),
          cpu_units: z.number().int().min(256).describe('vCPU units. 1024 = 1 vCPU.'),
          memory_mb: z.number().int().min(256).describe('Memory in MB. At most 2x cpu_units.'),
          ports: z
            .array(
              z.object({
                port: z.number().int().min(1).max(59999).describe('Port the server listens on.'),
                protocol: z
                  .string()
                  .describe('UDP, TCP, WS, or HTTP. Most game servers use UDP.'),
                name: z.string().optional().describe('Label, e.g. "gameport".'),
                to_check: z
                  .boolean()
                  .optional()
                  .describe('Readiness check on this port. Default true.'),
              })
            )
            .min(1)
            .describe('Ports to expose. At least one is required for players to connect.'),
          registry_username: z.string().optional().describe('Registry username, for private images.'),
          registry_token: z.string().optional().describe('Registry password or token.'),
          max_duration_minutes: z
            .number()
            .int()
            .optional()
            .describe('Auto-stop after this many minutes. Keeps test deployments from running up cost.'),
          verify_image: z
            .boolean()
            .optional()
            .describe('Verify Edgegap can pull the image before accepting the version.'),
          env: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Environment variables injected into the container.'),
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        guard(auth, async () => {
          assertAppAllowed(config, args.application);

          if (args.memory_mb > args.cpu_units * 2) {
            return fail(
              `memory_mb (${args.memory_mb}) exceeds twice cpu_units (${args.cpu_units}). ` +
                `Edgegap rejects this. Either lower memory_mb to ${args.cpu_units * 2} or raise cpu_units.`
            );
          }

          const requested = args.max_duration_minutes ?? config.maxDurationCeiling;
          const capped = Math.min(requested, config.maxDurationCeiling);

          const res = await client.createAppVersion(args.application, {
            name: args.name,
            is_active: true,
            req_cpu: args.cpu_units,
            req_memory: args.memory_mb,
            docker_repository: args.docker_repository,
            docker_image: args.docker_image,
            docker_tag: args.docker_tag,
            private_username: args.registry_username,
            private_token: args.registry_token,
            verify_image: args.verify_image ?? false,
            max_duration: capped,
            ports: args.ports.map((p) => ({
              port: p.port,
              protocol: p.protocol,
              name: p.name ?? 'gameport',
              to_check: p.to_check ?? true,
            })),
            envs: args.env?.map((e) => ({ key: e.key, value: e.value, is_hidden: false })),
          });

          return ok({
            created: `${args.application}/${res.version?.name ?? args.name}`,
            max_duration_minutes: capped,
            capped_by_server: capped < requested ? config.maxDurationCeiling : undefined,
            next_step: 'Call edgegap_deploy to start an instance.',
          });
        })
    );
  }

  // ---------------------------------------------------------------- 5 ----
  if (mutating) {
    server.registerTool(
      'edgegap_deploy',
      {
        title: 'Deploy a game server',
        description:
          'Start one containerized instance of an application version, placed near the players ' +
          'you specify. Returns immediately with a request_id; the server is still starting and ' +
          'has no connection details yet. Follow this call with edgegap_wait_for_deployment to ' +
          'get the address players connect to. Always stop deployments you started for testing.',
        inputSchema: {
          application: z.string().describe('Application name.'),
          version: z.string().describe('Version name within the application.'),
          users: userSchema,
          env: z
            .array(z.object({ key: z.string(), value: z.string() }))
            .optional()
            .describe('Environment variables for this deployment only.'),
          tags: z
            .array(z.string())
            .optional()
            .describe('Tags for filtering later, e.g. ["agent-test"]. Recommended.'),
          cpu_units: z.number().int().min(256).optional().describe('Override the version CPU.'),
          memory_mb: z.number().int().min(256).optional().describe('Override the version memory.'),
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) =>
        guard(auth, async () => {
          assertAppAllowed(config, args.application);

          const users = buildUsers(args.users);
          if (users.length === 0) {
            return fail(
              'No player locations given. Supply users.ip_addresses (e.g. the developer\'s own ' +
                'public IP) or users.geo_coordinates. Edgegap needs at least one to choose a region.'
            );
          }

          const body: Record<string, unknown> = {
            application: args.application,
            version: args.version,
            users,
            tags: args.tags ?? ['mcp'],
          };
          if (args.env) {
            body.environment_variables = args.env.map((e) => ({
              key: e.key,
              value: e.value,
              is_hidden: false,
            }));
          }
          if (args.cpu_units && args.memory_mb) {
            body.resources = { cpu_units: args.cpu_units, memory_mib: args.memory_mb };
          }

          const res = await client.deploy(body);
          return ok({
            request_id: res.request_id,
            status: 'starting',
            next_step: `Call edgegap_wait_for_deployment with request_id ${res.request_id}.`,
          });
        })
    );
  }

  // ---------------------------------------------------------------- 6 ----
  server.registerTool(
    'edgegap_get_deployment',
    {
      title: 'Get deployment status',
      description:
        'Read the current status of one deployment, including connection address and ports once ' +
        'it is ready. For a deployment you just created, prefer edgegap_wait_for_deployment — it ' +
        'polls for you instead of making you call this in a loop.',
      inputSchema: {
        request_id: z.string().describe('The request_id returned by edgegap_deploy.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }) =>
      guard(auth, async () => {
        const d = await client.getDeployment(request_id);
        return ok(compactDeployment(d));
      })
  );

  // ---------------------------------------------------------------- 7 ----
  server.registerTool(
    'edgegap_wait_for_deployment',
    {
      title: 'Wait for a deployment to become ready',
      description:
        'Poll a deployment until it is ready, errors, or the timeout expires, then return the ' +
        'connection details. This is the tool to call right after edgegap_deploy. Do not build ' +
        'your own polling loop — this handles backoff and reports the container error detail if ' +
        'the server fails to start.',
      inputSchema: {
        request_id: z.string().describe('The request_id returned by edgegap_deploy.'),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(600)
          .optional()
          .describe('How long to wait before giving up. Default 180.'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ request_id, timeout_seconds }) =>
      guard(auth, async () => {
        const budgetMs = (timeout_seconds ?? 180) * 1000;
        const startedAt = Date.now();
        let intervalMs = 2000;
        let last: DeploymentStatus | undefined;

        while (Date.now() - startedAt < budgetMs) {
          last = await client.getDeployment(request_id);
          const status = (last.current_status ?? '').toUpperCase();

          if (last.error || TERMINAL_BAD.some((s) => status.includes(s))) {
            return fail(
              `Deployment ${request_id} failed with status ${last.current_status}.\n` +
                `${last.error_detail ?? 'No error detail returned.'}\n\n` +
                `Call edgegap_get_deployment_logs for container output, then fix the image or ` +
                `port configuration before redeploying.`
            );
          }

          if (last.running || TERMINAL_OK.some((s) => status.includes(s))) {
            return ok({
              ...compactDeployment(last),
              waited_seconds: Math.round((Date.now() - startedAt) / 1000),
            });
          }

          await new Promise((r) => setTimeout(r, intervalMs));
          intervalMs = Math.min(intervalMs * 1.5, 10_000);
        }

        return fail(
          `Deployment ${request_id} did not become ready within ${timeout_seconds ?? 180}s. ` +
            `Last status: ${last?.current_status ?? 'unknown'}. It may still be starting — ` +
            `call edgegap_get_deployment to check again, or edgegap_stop_deployment to clean up.`
        );
      })
  );

  // ---------------------------------------------------------------- 8 ----
  server.registerTool(
    'edgegap_list_deployments',
    {
      title: 'List running deployments',
      description:
        'List active deployments, optionally filtered. Use this to find deployments left running ' +
        'from earlier sessions before starting new ones — orphaned servers cost money.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Edgegap filter expression, e.g. by tag. Omit for all deployments.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filter, limit }) =>
      guard(auth, async () => {
        const res = await client.listDeployments({ query: filter, limit: limit ?? 50 });
        const rows = (res.data ?? []).map((d) => ({
          request_id: d.request_id,
          ready: d.ready,
          fqdn: d.fqdn,
          started: d.start_time,
          tags: d.tags,
        }));
        return ok({ ...pageInfo(res.total_count, rows.length, 1), deployments: rows });
      })
  );

  // ---------------------------------------------------------------- 9 ----
  if (mutating) {
    server.registerTool(
      'edgegap_stop_deployment',
      {
        title: 'Stop a deployment',
        description:
          'Gracefully stop one deployment by request_id, sending SIGTERM to the container. ' +
          'Stop every deployment you started for testing before ending your task. This tool ' +
          'stops exactly one deployment; bulk stop is deliberately not exposed.',
        inputSchema: {
          request_id: z.string().describe('The request_id of the deployment to stop.'),
        },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ request_id }) =>
        guard(auth, async () => {
          const res = await client.stopDeployment(request_id);
          return ok({ request_id, result: res.message ?? 'stop requested' });
        })
    );
  }

  // --------------------------------------------------------------- 10 ----
  server.registerTool(
    'edgegap_get_deployment_logs',
    {
      title: 'Get container logs for a deployment',
      description:
        'Retrieve stdout/stderr and crash output for a deployment. Call this whenever a ' +
        'deployment errors or a server exits unexpectedly — the crash exit code usually ' +
        'identifies the problem faster than redeploying does. Logs for stopped deployments are ' +
        'only retained if Endpoint Storage was configured on the version beforehand.',
      inputSchema: {
        request_id: z.string().describe('The request_id of the deployment.'),
        max_characters: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .optional()
          .describe('Truncate logs to this length, keeping the tail. Default 8000.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id, max_characters }) =>
      guard(auth, async () => {
        const res = await client.getDeploymentLogs(request_id);
        const cap = max_characters ?? 8000;
        const tail = (s: string | null | undefined) =>
          !s ? undefined : s.length > cap ? `...[truncated]...\n${s.slice(-cap)}` : s;

        return ok({
          request_id,
          logs: tail(res.logs) ?? '(no logs returned)',
          crash_logs: tail(res.crash_logs),
          exit_code: res.crash_data?.exit_code,
          crash_message: res.crash_data?.message,
          restart_count: res.crash_data?.restart_count,
          storage_link: res.logs_link ?? undefined,
        });
      })
  );
}
