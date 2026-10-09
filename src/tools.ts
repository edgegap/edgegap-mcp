/**
 * The golden-path tools: getting a server image right and into a registry,
 * deploying it as an authoritative dedicated server, matching players into it,
 * and — for games built host-client — relays as the alternative.
 *
 * Tool descriptions are written for a coding agent, not a human reading docs.
 * Each one says when to reach for it and what to call next, because the main
 * failure mode in agent flows is not a bad call, it is a call made out of order.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EdgegapClient, EdgegapApiError, DeploymentStatus, RelaySession } from './client.js';
import { Config, assertAppAllowed, redact } from './config.js';
import { TokenSource, TokenUnavailableError } from './auth.js';
import {
  validateServerConfig,
  PROTOCOLS,
  NETCODE_NAMES,
} from './serverconfig.js';
import { generateDockerfile, DockerfileInputError } from './dockerfile.js';
import { buildMatchmakerConfig, DASHBOARD_URL } from './matchmaker.js';

/**
 * The one definition of "dedicated server vs relay" this server gives agents.
 * Used in the server instructions, the relay tool description, and every relay
 * result, so the recommendation cannot drift between them.
 *
 * Agents left alone tend to pick relays because they need no server image.
 * That optimises the agent's effort, not the developer's game, so the default
 * here is the authoritative server and relays need a stated reason.
 */
export const ARCHITECTURE_GUIDANCE =
  'Dedicated server vs relay — recommend a dedicated server by default.\n' +
  '- Dedicated (authoritative) server (edgegap_deploy): Edgegap runs the headless server ' +
  'build, and the server owns the game state. No player has host advantage, cheating is ' +
  'much harder, the match survives any player leaving, every player is one hop from the ' +
  'server, and performance does not depend on a player\'s PC or home connection.\n' +
  '- Relay (edgegap_create_relay_session): NOT a game server. Edgegap only forwards traffic ' +
  'between players; one player\'s game is the host and owns the state. The host can cheat ' +
  'and has zero latency while everyone else has two hops, the host\'s machine and upload ' +
  'bandwidth cap the match, and the match ends when the host quits unless the game ' +
  'implements host migration.\n' +
  'Use a relay only when the developer explicitly wants peer-to-peer/host-client, or the ' +
  'game\'s netcode is already built as a listen server and moving to a dedicated server is ' +
  'not an option. "It needs no server image" is not a reason: edgegap_generate_dockerfile ' +
  'removes most of that work. If unsure, ask the developer before choosing a relay.';

/**
 * Server instructions, shared by the local server and the hosted Worker so
 * both give agents the same golden path. Only the credential paragraph differs.
 */
export function serverInstructions(mode: 'local' | 'hosted'): string {
  const credentials =
    mode === 'local'
      ? 'Credentials: if no token was configured, the first tool call asks the developer for one. '
      : 'Credentials: the token comes from the Authorization header on this connection. ';
  return (
    'Host multiplayer games on Edgegap. The recommended setup is an authoritative dedicated ' +
    'server per match; relays exist for games built host-client.\n\n' +
    ARCHITECTURE_GUIDANCE +
    '\n\n' +
    'Golden path for a first dedicated-server deployment:\n' +
    '1. edgegap_generate_dockerfile if the project has no Dockerfile, or ' +
    'edgegap_validate_server_config on the one it has, before building\n' +
    '2. edgegap_get_registry_credentials, then docker build --platform linux/amd64 and push\n' +
    '3. edgegap_list_registry_tags to confirm the push landed\n' +
    '4. edgegap_list_apps, then edgegap_create_app if no suitable application exists\n' +
    '5. edgegap_create_app_version to register the image\n' +
    '6. edgegap_deploy to start a server near the players\n' +
    '7. edgegap_wait_for_deployment to get the connection address\n' +
    '8. edgegap_stop_deployment when finished\n' +
    'To match players into those servers, edgegap_build_matchmaker_config produces the ' +
    'config the developer uploads in the dashboard.\n\n' +
    'Deployments and relay sessions cost money while running. Tag test deployments, and ' +
    'stop deployments and delete relay sessions you created before ending the task. If a ' +
    'deployment errors, read the container logs before redeploying.\n\n' +
    credentials +
    'That token is org-wide and cannot be scoped by Edgegap, so it authorises far more than ' +
    'any single task needs. Treat it as a supervised credential: do not use it for work the ' +
    'developer did not ask for, do not enumerate or modify unrelated applications, and do ' +
    'not repeat operations against it to explore what is possible. If the developer declines ' +
    'to provide a token, stop and report which operation needed it — do not retry.'
  );
}

/** 1x1 transparent PNG. The create-app endpoint requires an image and agents
 *  have no sensible one to supply; a placeholder beats a blocked flow. */
const PLACEHOLDER_IMAGE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Port protocols, uppercased. The API accepts "WS" but returns "Websocket". */
const WS_PROTOCOLS = new Set(['WS', 'WEBSOCKET']);
/** tls_upgrade is only valid on WebSocket and HTTP ports (per the API spec). */
const TLS_PROTOCOLS = new Set(['WS', 'WEBSOCKET', 'HTTP']);

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

/**
 * What a 404 means, per kind of resource. A 404 from Edgegap only says "not
 * found"; which thing is missing, and what to do next, depends on the tool.
 * One generic hint used to be attached to every 404, which sent agents to
 * edgegap_list_apps for stopped deployments and missing registry images.
 */
const NOT_FOUND = {
  app:
    'the application or version name does not exist. Call edgegap_list_apps, then ' +
    'edgegap_list_app_versions, to find the right names.',
  deployment:
    'no deployment with that request_id. It may have stopped and been cleaned up, or the ' +
    'request_id is wrong. Running deployments are listed by edgegap_list_deployments.',
  logs:
    'no logs for this deployment. Container logs only exist while a deployment is running; ' +
    'once it has stopped they are gone, unless Endpoint Storage was configured on the version ' +
    'before it ran. If it is still running, check the request_id with edgegap_list_deployments.',
  relay: 'no relay session with that session_id. It may already have been deleted.',
} as const;

/** Wraps a handler so API errors come back as readable, self-correctable text
 *  rather than a protocol-level exception the agent cannot act on. */
function guard(
  auth: TokenSource,
  fn: () => Promise<ToolResult>,
  notFound?: string
): Promise<ToolResult> {
  const handled = fn().catch((err: unknown): ToolResult => {
    if (err instanceof TokenUnavailableError) {
      // Not a failure to correct — a decision the human made. Say so plainly
      // so the agent stops rather than looping on the same tool.
      return fail(err.message);
    }
    if (err instanceof EdgegapApiError) {
      const hint = errorHint(err, notFound);
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

/** guard() with the 404 hint first, so it reads at the call site. */
function guarded(
  auth: TokenSource,
  notFound: string,
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  return guard(auth, fn, notFound);
}

function errorHint(err: EdgegapApiError, notFound?: string): string | undefined {
  switch (err.status) {
    case 401:
      // Deliberately does not promise a re-prompt: the local server asks again
      // on the next call, the hosted relay cannot, and a hint that lies about
      // what happens next sends the developer looking in the wrong place.
      return (
        'Edgegap rejected the token. It may be expired, revoked, or from a ' +
        'different organization. Check it at ' +
        'https://app.edgegap.com/user-settings?tab=tokens. The token has been ' +
        'discarded from this session.'
      );
    case 400:
      // The deployment endpoints answer an unknown request_id with 400 ("Bad
      // Request ID provided", or a generic "could not understand" for logs),
      // not 404. Their only input is the request_id, so a 400 means that.
      return notFound === NOT_FOUND.deployment || notFound === NOT_FOUND.logs ? notFound : undefined;
    case 404:
      // Only the tool knows what was not found; no hint beats a wrong one.
      return notFound;
    case 429:
      return 'Edgegap rate-limited this token. Wait a few seconds before the next call, and do not retry in a loop.';
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
        'List the versions under an application, with their container image, resources, ports ' +
        '(including whether TLS Upgrade is on, which browser/WebGL clients need for wss://) and ' +
        'whether a registry login is set for pulling the image. Use this to find the version ' +
        'name to deploy, to check a version is ready before deploying, or to copy settings from ' +
        'a working version when creating a new one.',
      inputSchema: {
        application: z.string().describe('Application name, as returned by edgegap_list_apps.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ application }) =>
      // Read-only, so not subject to EDGEGAP_APP_ALLOWLIST: the allowlist
      // limits what the agent can create and deploy into, as documented.
      guarded(auth, NOT_FOUND.app, async () => {
        const res = await client.listAppVersions(application);
        const versions = (res.versions ?? []).map((v) => ({
          name: v.name,
          active: v.is_active,
          image: [v.docker_repository, v.docker_image, v.docker_tag].filter(Boolean).join('/'),
          // Whether a login is set, never the login itself: the API returns
          // the registry token in this response.
          registry_credentials_set: Boolean(v.private_username && v.private_token),
          cpu_units: v.req_cpu,
          memory_mb: v.req_memory,
          max_duration_minutes: v.max_duration,
          ports: v.ports?.map((p) => ({
            name: p.name,
            port: p.port,
            protocol: p.protocol,
            tls_upgrade: p.tls_upgrade ?? false,
          })),
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
          'already be pushed to a registry that Edgegap can pull from (see ' +
          'edgegap_get_registry_credentials and edgegap_list_registry_tags). Resource units: 1024 cpu ' +
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
                  .describe(`One of ${PROTOCOLS.join(', ')}. Most game servers use UDP.`),
                name: z.string().optional().describe('Label, e.g. "gameport".'),
                to_check: z
                  .boolean()
                  .optional()
                  .describe('Readiness check on this port. Default true.'),
                tls_upgrade: z
                  .boolean()
                  .optional()
                  .describe(
                    'Edgegap terminates TLS on this port, so clients connect with wss:// or https://. ' +
                      'Required for browser (WebGL) clients, which cannot use plain ws:// from an https page. ' +
                      'WS and HTTP ports only. Default false.'
                  ),
              })
            )
            .min(1)
            .describe('Ports to expose. At least one is required for players to connect.'),
          registry_username: z
            .string()
            .optional()
            .describe(
              'Registry username. Needed for private images, including images in your own ' +
                'registry.edgegap.com project: Edgegap pulls with this login, not your API token.'
            ),
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
        guarded(auth, NOT_FOUND.app, async () => {
          assertAppAllowed(config, args.application);

          if (args.memory_mb > args.cpu_units * 2) {
            return fail(
              `memory_mb (${args.memory_mb}) exceeds twice cpu_units (${args.cpu_units}). ` +
                `Edgegap rejects this. Either lower memory_mb to ${args.cpu_units * 2} or raise cpu_units.`
            );
          }

          const badTls = args.ports.find((p) => p.tls_upgrade && !TLS_PROTOCOLS.has(p.protocol.toUpperCase()));
          if (badTls) {
            return fail(
              `Port ${badTls.port} is ${badTls.protocol}; tls_upgrade only works on WS and HTTP ports. ` +
                'Use protocol "WS" for a WebSocket server, or drop tls_upgrade.'
            );
          }

          const requested = args.max_duration_minutes ?? config.maxDurationCeiling;
          const capped = Math.min(requested, config.maxDurationCeiling);
          const hasRegistryLogin = Boolean(args.registry_username && args.registry_token);
          const edgegapRegistry = /(^|\/\/)registry\.edgegap\.com\/?$/.test(args.docker_repository.trim());

          let res;
          try {
            res = await client.createAppVersion(args.application, {
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
                tls_upgrade: p.tls_upgrade ?? false,
              })),
              envs: args.env?.map((e) => ({ key: e.key, value: e.value, is_hidden: false })),
            });
          } catch (err) {
            // verify_image pulls with the version's registry login. Without one
            // — even for the org's own registry.edgegap.com project — Edgegap
            // answers a bare 400 "Unable to login with the given credentials".
            if (err instanceof EdgegapApiError && err.status === 400 && /login|credential/i.test(err.apiMessage)) {
              return fail(registryLoginNeeded(args.docker_repository, hasRegistryLogin));
            }
            throw err;
          }

          const notes: string[] = [];
          if (edgegapRegistry && !hasRegistryLogin) {
            notes.push(
              'No registry login was set. Edgegap pulls images from registry.edgegap.com with the ' +
                'version\'s registry login, not your API token, so deployments of this version will ' +
                'likely fail to pull (424) until the developer adds the Container Registry username ' +
                'and token to this version in the dashboard.'
            );
          }
          for (const p of args.ports) {
            if (WS_PROTOCOLS.has(p.protocol.toUpperCase()) && !p.tls_upgrade) {
              notes.push(
                `Port ${p.port} is WebSocket without tls_upgrade. If clients run in a browser (WebGL), ` +
                  'they need wss://: create the version with tls_upgrade: true on this port.'
              );
            }
          }

          return ok({
            created: `${args.application}/${res.version?.name ?? args.name}`,
            max_duration_minutes: capped,
            capped_by_server: capped < requested ? config.maxDurationCeiling : undefined,
            notes: notes.length ? notes : undefined,
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
          'Start one authoritative dedicated game server from an application version, placed near ' +
          'the players you specify. This is the recommended way to host a multiplayer match: the ' +
          'server owns the game state, so no player hosts it. Returns immediately with a request_id; the server is still starting and ' +
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
        guarded(auth, NOT_FOUND.app, async () => {
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
      guarded(auth, NOT_FOUND.deployment, async () => {
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
      guarded(auth, NOT_FOUND.deployment, async () => {
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
        'List active deployments, optionally filtered and sorted. Use this to find deployments left running ' +
        'from earlier sessions before starting new ones — orphaned servers cost money. ' +
        'Filter by status, application, version, tags, request_id, created_at, fleet_name or host_name, ' +
        'e.g. [{field:"application",operator:"eq",value:"my-game"},{field:"status",operator:"eq",value:"ready"}]. ' +
        'Operators: eq and neq on every field except created_at (eq, gte, lte); in and nin with an array value ' +
        'on request_id, tags, application, version, fleet_name, host_name; ilike with % wildcards on fleet_name ' +
        'and host_name. At most one filter per field. Sort by created_at or available_session_sockets.',
      inputSchema: {
        filters: z
          .array(
            z.object({
              field: z.enum([
                'status', 'request_id', 'tags', 'created_at', 'application',
                'version', 'fleet_name', 'host_name',
              ]),
              operator: z.enum(['eq', 'neq', 'in', 'nin', 'gte', 'lte', 'ilike']),
              value: z
                .union([z.string(), z.array(z.string())])
                .describe('A string, or an array of strings for in/nin. created_at is ISO 8601, e.g. "2026-09-30T00:00:00Z".'),
            })
          )
          .optional()
          .describe('Omit for all deployments.'),
        order_by: z
          .array(
            z.object({
              field: z.enum(['created_at', 'available_session_sockets']),
              order: z.enum(['asc', 'desc']),
            })
          )
          .optional()
          .describe('e.g. [{field:"created_at",order:"asc"}] for oldest first.'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ filters, order_by, limit }) =>
      guard(auth, async () => {
        const fields = (filters ?? []).map((f) => f.field);
        const repeated = fields.find((f, i) => fields.indexOf(f) !== i);
        if (repeated) {
          return fail(`Only one filter per field is allowed, and "${repeated}" has more than one. Combine them with "in" or "nin".`);
        }
        const query =
          filters?.length || order_by?.length
            ? JSON.stringify({ filters: filters ?? [], ...(order_by?.length ? { order_by } : {}) })
            : undefined;
        const res = await client.listDeployments({ query, limit: limit ?? 50 });
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
        guarded(auth, NOT_FOUND.deployment, async () => {
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
      guarded(auth, NOT_FOUND.logs, async () => {
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

  // ============================================= before the first deploy ====

  // -------------------------------------------------------------- 11a ----
  // Pure text generation: no token, no network, so it is always registered and
  // never goes through guard().
  server.registerTool(
    'edgegap_generate_dockerfile',
    {
      title: 'Generate a game server Dockerfile',
      description:
        'Write a Dockerfile for this project\'s headless game server build, ready for Edgegap: ' +
        'linux/amd64 base, the build folder copied in, the binary made executable, the right ' +
        'headless flags (Unity -batchmode -nographics, Godot --headless), a non-root user where ' +
        'the engine needs it (Unreal refuses root), CRLF fixes for start scripts, and EXPOSE ' +
        'lines matching the ports. Call this when the project has no Dockerfile, before ' +
        'building anything. Look at the build output first so you can pass the real build ' +
        'folder, binary name and port; anything you omit is assumed and listed under ' +
        'assumptions, which you must confirm with the developer or the project files. Write the ' +
        'result to Dockerfile, then build. The output is checked against ' +
        'edgegap_validate_server_config before it is returned. Makes no API calls.',
      inputSchema: {
        engine: z.enum(['unity', 'unreal', 'godot', 'other']).describe('Game engine of the server build.'),
        build_path: z
          .string()
          .optional()
          .describe(
            'Server build folder, relative to where docker build runs. Defaults: unity ' +
              '"Builds/EdgegapServer", unreal "." (run from inside the packaged LinuxServer folder), godot "build".'
          ),
        executable: z
          .string()
          .optional()
          .describe(
            'File name of the server binary or start script inside build_path. Defaults: unity ' +
              '"ServerBuild", unreal "StartServer.sh", godot "server.x86_64". Required for "other".'
          ),
        ports: z
          .array(
            z.object({
              port: z.number().int().min(1).max(59999),
              protocol: z.enum(PROTOCOLS),
              name: z.string().optional(),
              tls_upgrade: z.boolean().optional().describe('TLS Upgrade (wss/https) on a WS or HTTP port, for browser clients.'),
            })
          )
          .optional()
          .describe('Ports the server listens on. Default: 7777, with the protocol the netcode uses (UDP if unknown).'),
        netcode: z
          .string()
          .optional()
          .describe(`Networking transport, to pick the protocol. Known: ${NETCODE_NAMES.join(', ')}.`),
        launch_args: z
          .array(z.string())
          .optional()
          .describe('Extra server arguments, one per entry, e.g. ["-log", "-port=7777"].'),
        base_image: z.string().optional().describe('Default "ubuntu:22.04".'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      let generated;
      try {
        generated = generateDockerfile(args);
      } catch (err) {
        if (err instanceof DockerfileInputError) return fail(err.message);
        throw err;
      }

      // Never hand back something our own validator would reject.
      const check = validateServerConfig({
        dockerfile: generated.dockerfile,
        engine: args.engine,
        netcode: args.netcode,
        ports: generated.ports,
      });
      if (check.errors.length > 0) {
        return fail(
          'The generated Dockerfile failed validation, which means these inputs combine badly:\n- ' +
            check.errors.map((e) => `${e.message} ${e.fix}`).join('\n- ')
        );
      }

      const ref = '<image>:<unique-build-tag>';
      const portFlags = generated.ports
        .flatMap((p) =>
          p.protocol === 'TCP/UDP'
            ? [`-p ${p.port}:${p.port}/udp`, `-p ${p.port}:${p.port}/tcp`]
            : [`-p ${p.port}:${p.port}/${p.protocol === 'UDP' ? 'udp' : 'tcp'}`]
        )
        .join(' ');

      return ok({
        dockerfile: generated.dockerfile,
        assumptions: generated.assumptions,
        warnings: check.warnings.length ? check.warnings : undefined,
        ports_for_create_app_version: generated.ports,
        commands: {
          build: `docker build --platform linux/amd64 -t ${ref} .`,
          // --platform belongs on build only: the image is already linux/amd64.
          test_locally: `docker run --rm ${portFlags} ${ref}`,
        },
        next_step:
          'Confirm every assumption, write this to Dockerfile, build it, and run it locally to check ' +
          'the server starts and stays up. Then push it (edgegap_get_registry_credentials) and ' +
          'register it with edgegap_create_app_version using ports_for_create_app_version.',
      });
    }
  );

  // --------------------------------------------------------------- 11 ----
  // Pure text analysis: no token, no network, so it is always registered and
  // never goes through guard().
  server.registerTool(
    'edgegap_validate_server_config',
    {
      title: 'Validate a game server Dockerfile and port config',
      description:
        'Check a game server Dockerfile and the ports/resources you intend to register against ' +
        'what Edgegap requires, BEFORE building and pushing. Catches the failures that otherwise ' +
        'only show up after a build, push, version and deploy: ARM or Windows images (Edgegap ' +
        'runs linux/amd64), Unreal running as root, missing Unity -batchmode -nographics, a ' +
        'server bound to localhost, EXPOSE ports that do not match the version ports, a protocol ' +
        'that does not match the netcode transport, the "latest" tag, and bad CPU/memory ratios. ' +
        'Pass the Dockerfile text (read it from disk first). If there is no Dockerfile yet, call ' +
        'edgegap_generate_dockerfile instead. Makes no API calls.',
      inputSchema: {
        dockerfile: z.string().optional().describe('Full text of the Dockerfile.'),
        engine: z
          .enum(['unity', 'unreal', 'godot', 'other'])
          .optional()
          .describe('Game engine. Detected from the Dockerfile when omitted.'),
        netcode: z
          .string()
          .optional()
          .describe(`Networking transport, to check the port protocol. Known: ${NETCODE_NAMES.join(', ')}.`),
        ports: z
          .array(
            z.object({
              port: z.number().int(),
              protocol: z.string(),
              name: z.string().optional(),
              tls_upgrade: z.boolean().optional().describe('TLS Upgrade (wss/https) on a WS or HTTP port, for browser clients.'),
            })
          )
          .optional()
          .describe('Ports you plan to pass to edgegap_create_app_version.'),
        cpu_units: z.number().int().optional(),
        memory_mb: z.number().int().optional(),
        docker_repository: z.string().optional(),
        docker_image: z.string().optional(),
        docker_tag: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const { engine, errors, warnings } = validateServerConfig(args);
      // A known-good starting point when there is nothing to check, or what was
      // checked is broken. Only for engines with a real default binary name.
      const reference =
        engine !== 'other' && (args.dockerfile === undefined || errors.length > 0)
          ? generateDockerfile({ engine, ports: args.ports, netcode: args.netcode }).dockerfile
          : undefined;
      const verdict = errors.length > 0 ? 'fail' : warnings.length > 0 ? 'pass_with_warnings' : 'pass';

      return ok({
        verdict,
        engine,
        errors,
        warnings,
        checked: {
          dockerfile: args.dockerfile !== undefined,
          ports: args.ports !== undefined,
          resources: args.cpu_units !== undefined || args.memory_mb !== undefined,
          image: args.docker_tag !== undefined || args.docker_image !== undefined,
        },
        reference_dockerfile: reference,
        next_step:
          verdict === 'fail'
            ? 'Fix every error and call this again before building. Do not build or push an image that ' +
              'fails here. edgegap_generate_dockerfile can write a correct one for this project.'
            : 'Build with "docker build --platform linux/amd64 -t <image>:<unique-tag> ." and run it ' +
              'locally with the same port mapping to confirm it starts. Then push it; ' +
              'edgegap_get_registry_credentials gives you a registry and the exact commands.',
      });
    }
  );

  // --------------------------------------------------------------- 12 ----
  // Mutating-only: it can provision the registry project, and it hands a
  // secret to the agent. A read-only session has no business receiving one.
  if (mutating) {
    server.registerTool(
      'edgegap_get_registry_credentials',
      {
        title: 'Get Edgegap container registry push credentials',
        description:
          'Get the push login for this organization\'s private Edgegap container registry ' +
          '(registry.edgegap.com) and the exact docker login, build and push commands for your ' +
          'image. Use this when the server image is not in a registry yet. Edgegap only hands ' +
          'these credentials to the quick-start token the Unity/Unreal plugins use; with a ' +
          'regular API token this tool cannot fetch them and instead returns the steps to copy ' +
          'them from the dashboard\'s Container Registry page — ask the developer for them then, ' +
          'do not retry. When it does return a token, it is registry-scoped (push/pull images in ' +
          'this project), not the org API token: pass it to docker login via --password-stdin, ' +
          'never as a command-line argument, and do not write it into files. Call ' +
          'edgegap_validate_server_config before building.',
        inputSchema: {
          image_name: z
            .string()
            .regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/, 'lowercase letters, digits, ".", "_" or "-"')
            .optional()
            .describe('Image name without project or tag, e.g. "my-game-server". Used to build the commands.'),
          tag: z
            .string()
            .optional()
            .describe('Unique build tag for the commands, e.g. a build ID. Never "latest".'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ image_name, tag }) =>
        guard(auth, async () => {
          if (tag === 'latest') {
            return fail('Do not use the "latest" tag: Edgegap caches by tag, so a re-pushed "latest" can deploy a stale build. Pass a build ID or timestamp.');
          }

          // Both wizard endpoints answer 403 to a regular API token: they belong
          // to the plugins' quick-start flow. 403 is the token type, not a
          // missing registry, so it must not trigger provisioning (which only
          // fails with a second, more confusing 403). Only a 404 — a
          // quick-start token whose project is not provisioned yet — does.
          const unavailable = () => fail(registryCredentialsUnavailable(image_name, tag));
          let creds;
          try {
            creds = await client.getRegistryCredentials();
          } catch (err) {
            if (!(err instanceof EdgegapApiError)) throw err;
            if (err.status === 403) return unavailable();
            if (err.status !== 404) throw err;
            try {
              await client.initQuickStart('mcp');
            } catch (initErr) {
              if (initErr instanceof EdgegapApiError && initErr.status === 403) return unavailable();
              throw initErr;
            }
            creds = await client.getRegistryCredentials();
          }

          if (!creds.project || !creds.username || !creds.token) return unavailable();

          const host = (creds.registry_url || 'registry.edgegap.com').replace(/^https?:\/\//, '').replace(/\/$/, '');
          const image = image_name ?? '<image-name>';
          const buildTag = tag ?? '<unique-build-tag>';
          const ref = `${host}/${creds.project}/${image}:${buildTag}`;

          return ok({
            registry_url: host,
            project: creds.project,
            username: creds.username,
            token: creds.token,
            image_ref: ref,
            commands: {
              login:
                `printf '%s' "$EDGEGAP_REGISTRY_TOKEN" | docker login ${host} -u '${creds.username}' --password-stdin`,
              build: `docker build --platform linux/amd64 -t ${ref} .`,
              push: `docker push ${ref}`,
            },
            for_create_app_version: {
              docker_repository: host,
              docker_image: `${creds.project}/${image}`,
              docker_tag: buildTag,
              registry_username: creds.username,
              registry_token: '<the token above>',
            },
            next_step:
              'Export the token as EDGEGAP_REGISTRY_TOKEN in the shell that runs docker login ' +
              '(it never needs to appear in a command line or file), then build and push. ' +
              `Confirm the push with edgegap_list_registry_tags (image_name "${image}", without the project), ` +
              'then call edgegap_create_app_version with the values in for_create_app_version.',
          });
        })
    );
  }

  // --------------------------------------------------------------- 13 ----
  server.registerTool(
    'edgegap_list_registry_tags',
    {
      title: 'List image tags in the Edgegap registry',
      description:
        'List the tags pushed for one image in this organization\'s Edgegap container registry, ' +
        'with push time and size. Call it after docker push to confirm the tag landed before ' +
        'edgegap_create_app_version, which otherwise fails later with an image-pull error.',
      inputSchema: {
        image_name: z
          .string()
          .min(1)
          .describe(
            'The image name only, without the project, registry host or tag, e.g. "my-game-server". ' +
              'The API reads the project from your token; "<project>/my-game-server" is not found.'
          ),
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ image_name, page, limit }) =>
      guard(auth, async () => {
        // Agents often pass the full reference they pushed. Reduce it to what
        // the API wants: no "registry.edgegap.com/" host, no ":tag".
        const parts = image_name.replace(/@sha256:.*$/, '').split('/');
        if (parts.length > 1 && /[.:]/.test(parts[0])) parts.shift();
        parts[parts.length - 1] = parts[parts.length - 1].replace(/:[^:]*$/, '');
        let name = parts.join('/');

        const query = { page, limit: limit ?? 20 };
        const notFound = (err: unknown) => err instanceof EdgegapApiError && err.status === 404;
        let res;
        try {
          try {
            res = await client.listRegistryTags(name, query);
          } catch (err) {
            // Nested image names are valid, so try the name as given first. If
            // it is "<project>/<image>", that 404s; retry without the project.
            if (!notFound(err) || !name.includes('/')) throw err;
            name = name.slice(name.indexOf('/') + 1);
            res = await client.listRegistryTags(name, query);
          }
        } catch (err) {
          // The generic 404 hint points at applications, which is wrong here.
          if (!notFound(err)) throw err;
          return fail(
            `No image named "${name}" in this organization's Edgegap registry, so nothing has been ` +
              'pushed under that name. Check the name (image name only, as used after ' +
              '"registry.edgegap.com/<project>/" in docker push), or push the image first.'
          );
        }

        const tags = (res.data ?? []).map((t) => ({
          tag: t.tag,
          pushed: t.last_push_at,
          size_mb: t.artifact?.size_mb,
          digest: t.artifact?.image_hash,
        }));
        const hasNext = res.pagination?.has_next === true;
        return ok({
          image_name: name,
          note: name !== image_name ? `Looked up "${name}". Pass the image name only next time.` : undefined,
          total: res.count ?? tags.length,
          ...(hasNext
            ? {
                showing: tags.length,
                truncated: true,
                next_step: `Only page ${page ?? 1} is shown. Call again with page: ${(page ?? 1) + 1} before concluding a tag is missing.`,
              }
            : {}),
          tags,
        });
      })
  );

  // ================================================== peer-to-peer relays ====

  // --------------------------------------------------------------- 14 ----
  if (mutating) {
    server.registerTool(
      'edgegap_create_relay_session',
      {
        title: 'Create a relay session (host-client games only)',
        description:
          'A relay is NOT a game server and is not the recommended default — for a multiplayer ' +
          'match, deploy an authoritative dedicated server with edgegap_deploy instead. A relay ' +
          'only forwards traffic between players while one player\'s game acts as host and owns ' +
          'the game state: the host can cheat and has a latency advantage, the host\'s PC and ' +
          'connection cap the match, and the match ends if the host quits. Only use this when the ' +
          'developer has chosen peer-to-peer/host-client, or the netcode is already a listen ' +
          'server and a dedicated server is not an option; if that has not been established, ask ' +
          'first. Never pick it only because it needs no server image. ' +
          'Creates an Edgegap relay session for every player\'s public IP, host first, waits until ' +
          'it is ready, and returns the relay address plus per-player authorization tokens for the ' +
          'relay transport. Relay sessions are billed while open: delete test sessions with ' +
          'edgegap_delete_relay_session when finished.',
        inputSchema: {
          user_ips: z
            .array(z.string().min(3))
            .min(1)
            .describe('Public IP of each player, host first. Add late joiners with edgegap_authorize_relay_user.'),
          webhook_url: z.string().url().optional().describe('Called when the session is ready.'),
          wait_until_ready: z.boolean().optional().describe('Poll until the relay is assigned. Default true.'),
          timeout_seconds: z.number().int().min(5).max(120).optional().describe('Default 30.'),
        },
        annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ user_ips, webhook_url, wait_until_ready, timeout_seconds }) =>
        guard(auth, async () => {
          const created = await client.createRelaySession({
            users: user_ips.map((ip) => ({ ip })),
            ...(webhook_url ? { webhook_url } : {}),
          });

          if (wait_until_ready === false) {
            return ok({
              ...compactRelay(created),
              next_step: `Call edgegap_get_relay_session with session_id ${created.session_id} until ready is true.`,
            });
          }

          const budgetMs = (timeout_seconds ?? 30) * 1000;
          const startedAt = Date.now();
          let intervalMs = 1000;
          let last: RelaySession = created;
          while (!last.ready && !last.error && Date.now() - startedAt < budgetMs) {
            await new Promise((r) => setTimeout(r, intervalMs));
            intervalMs = Math.min(intervalMs * 1.5, 5000);
            last = await client.getRelaySession(created.session_id);
          }

          if (last.error) {
            return fail(
              `Relay session ${created.session_id} failed: ${last.error}\n\n` +
                'Check that every IP is a public address (not 127.x, 10.x, 192.168.x), then delete ' +
                'this session with edgegap_delete_relay_session and create a new one.'
            );
          }
          if (!last.ready) {
            return fail(
              `Relay session ${created.session_id} was not ready after ${timeout_seconds ?? 30}s ` +
                `(status ${last.status ?? 'unknown'}). Call edgegap_get_relay_session to check again.`
            );
          }
          return ok({ ...compactRelay(last), waited_seconds: Math.round((Date.now() - startedAt) / 1000) });
        })
    );
  }

  // --------------------------------------------------------------- 15 ----
  server.registerTool(
    'edgegap_get_relay_session',
    {
      title: 'Get a relay session',
      description:
        'Read one relay session: whether it is ready, the relay address and ports, and each ' +
        'authorized player with their authorization token. edgegap_create_relay_session already ' +
        'waits for readiness; use this to re-read a session or one created with wait_until_ready false.',
      inputSchema: { session_id: z.string().describe('Returned by edgegap_create_relay_session.') },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ session_id }) =>
      guarded(auth, NOT_FOUND.relay, async () => ok(compactRelay(await client.getRelaySession(session_id))))
  );

  if (mutating) {
    // ------------------------------------------------------------- 16 ----
    server.registerTool(
      'edgegap_authorize_relay_user',
      {
        title: 'Add a player to a relay session',
        description:
          'Authorize one more player (by public IP) on an existing relay session, for a player ' +
          'joining after the session was created. Returns that player\'s authorization token.',
        inputSchema: {
          session_id: z.string(),
          user_ip: z.string().min(3).describe('Public IP of the joining player.'),
        },
        annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async ({ session_id, user_ip }) =>
        guarded(auth, NOT_FOUND.relay, async () => {
          const res = await client.authorizeRelayUser({ session_id, user_ip });
          return ok({
            session_id: res.session_id,
            user_ip,
            user_authorization_token: res.session_user?.authorization_token,
            session_authorization_token: res.authorization_token,
          });
        })
    );

    // ------------------------------------------------------------- 17 ----
    server.registerTool(
      'edgegap_delete_relay_session',
      {
        title: 'Delete a relay session',
        description:
          'Close one relay session. Connected players lose their relay connection. Delete every ' +
          'session you created for testing before ending your task.',
        inputSchema: { session_id: z.string() },
        annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      async ({ session_id }) =>
        guarded(auth, NOT_FOUND.relay, async () => {
          await client.deleteRelaySession(session_id);
          return ok({ session_id, result: 'deleted' });
        })
    );
  }

  // ============================================================ matchmaker ====

  // --------------------------------------------------------------- 18 ----
  // Edgegap has no public API to create a matchmaker, so this does not create
  // one. It produces the configuration the dashboard asks for, checked against
  // the application version it points at.
  server.registerTool(
    'edgegap_build_matchmaker_config',
    {
      title: 'Build a basic matchmaker configuration',
      description:
        'Generate a ready-to-upload Edgegap matchmaker JSON configuration with one profile: team ' +
        'count and size, optional latency rule, and optional expansions that relax the rules the ' +
        'longer a player waits. Checks the referenced application version exists and has ports. ' +
        'Edgegap has no API for creating a matchmaker, so this tool does NOT create one: save the ' +
        'returned config to a file (e.g. matchmaker-config.json) and have the developer upload it ' +
        'on the Matchmaker page of the dashboard. The matchmaker starts an authoritative dedicated ' +
        'server for each match, which is the recommended setup for multiplayer games.',
      inputSchema: {
        profile_name: z.string().describe('Profile clients will queue into, e.g. "casual-2v2".'),
        application: z.string().describe('Application the matchmaker deploys.'),
        version: z.string().describe('Version the matchmaker deploys.'),
        team_count: z.number().int().min(1).describe('Teams per match. 1 for free-for-all or co-op.'),
        min_team_size: z.number().int().min(1),
        max_team_size: z.number().int().min(1),
        max_latency_ms: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Adds a latency rule: drop players above this ping to the chosen region. Needs beacon pings from the client.'),
        latency_difference_ms: z.number().int().min(0).optional().describe('Max ping spread between matched players. Default 100.'),
        expansions: z
          .array(
            z.object({
              after_seconds: z.number().int().min(1),
              min_team_size: z.number().int().min(1).optional(),
              max_latency_ms: z.number().int().min(1).optional(),
            })
          )
          .optional()
          .describe('Rule relaxations after a player has waited this long, e.g. [{after_seconds: 30, min_team_size: 1}].'),
        ticket_expiration: z.string().optional().describe('Default "5m".'),
        inspect: z.boolean().optional().describe('Expose the inspection API for debugging. Default true; turn off for production.'),
        verify_version: z.boolean().optional().describe('Look up the application version first. Default true.'),
        allowed_cors_origins: z
          .array(z.string())
          .optional()
          .describe(
            'Origins of web pages allowed to call the matchmaker, e.g. ["https://mygame.example.com", ' +
              '"http://localhost:8080"]. Required when game clients run in a browser (WebGL): browsers ' +
              'block matchmaker calls from any origin not listed. Scheme and host only, no path.'
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guarded(auth, NOT_FOUND.app, async () => {
        assertAppAllowed(config, args.application);
        const { config: mmConfig, problems, cautions } = buildMatchmakerConfig(args);

        if (args.verify_version !== false) {
          try {
            const res = await client.listAppVersions(args.application);
            const v = (res.versions ?? []).find((x) => x.name === args.version);
            if (!v) {
              problems.push(
                `Version "${args.version}" was not found in application "${args.application}". ` +
                  'Create it with edgegap_create_app_version, or pick one from edgegap_list_app_versions.'
              );
            } else {
              if (v.is_active === false) problems.push(`Version "${args.version}" is inactive, so the matchmaker cannot deploy it.`);
              if (!v.ports?.length) problems.push(`Version "${args.version}" has no ports, so matched players have nothing to connect to.`);
            }
          } catch (err) {
            if (err instanceof EdgegapApiError && err.status === 404) {
              problems.push(`Application "${args.application}" does not exist. Call edgegap_list_apps.`);
            } else {
              throw err;
            }
          }
        }

        if (problems.length > 0) {
          return fail(
            'The matchmaker configuration has problems; fix them before uploading:\n- ' +
              problems.join('\n- ') +
              `\n\nDraft config:\n${JSON.stringify(mmConfig, null, 2)}`
          );
        }

        return ok({
          config: mmConfig,
          cautions: cautions.length ? cautions : undefined,
          next_steps: [
            'Write config to matchmaker-config.json in the project.',
            `The developer uploads it in the dashboard (${DASHBOARD_URL}, Matchmaker page, Create Matchmaker) and waits for it to show as ready. The free tier runs on a shared test cluster for up to 3 hours per restart.`,
            'The dashboard then shows the matchmaker API URL and auth token. Game clients call POST {api_url}/tickets ' +
              `with header "Authorization: <auth token>" and profile "${args.profile_name}", then poll GET {api_url}/memberships/{id} until it returns the server address.`,
            'That auth token is safe to ship in game clients: it grants no access to the Edgegap API.',
            args.allowed_cors_origins?.length
              ? `Browser clients are allowed from: ${args.allowed_cors_origins.join(', ')}. Add any other origin the game is served from (each staging or production URL) before uploading.`
              : 'If game clients run in a browser (WebGL), set allowed_cors_origins to the origin of every page that serves the game, including http://localhost:<port> for local testing, or browsers will block the matchmaker calls.',
          ],
        });
      })
  );
}

/**
 * What edgegap_get_registry_credentials says when Edgegap will not hand the
 * registry login to this token. Written as the manual path that works today,
 * so the agent asks the developer instead of retrying or guessing.
 */
function registryCredentialsUnavailable(imageName?: string, tag?: string): string {
  const image = imageName ?? '<image-name>';
  const buildTag = tag ?? '<unique-build-tag>';
  const ref = `registry.edgegap.com/<project>/${image}:${buildTag}`;
  return (
    'Edgegap does not give container registry credentials to a regular API token: the ' +
    'endpoint only accepts the quick-start token the Unity/Unreal plugins use (it answered ' +
    '403). This is the token type, not a problem with the registry. Do not retry. Ask the ' +
    'developer for the registry login instead:\n\n' +
    `1. In the dashboard (${DASHBOARD_URL}), open the Container Registry page and copy the ` +
    'Project, Username and Token.\n' +
    '2. Log in with the token read from an environment variable, never as an argument:\n' +
    `   printf '%s' "$EDGEGAP_REGISTRY_TOKEN" | docker login registry.edgegap.com -u '<username>' --password-stdin\n` +
    `3. docker build --platform linux/amd64 -t ${ref} .\n` +
    `4. docker push ${ref}\n` +
    `5. Confirm with edgegap_list_registry_tags (image_name "${image}", without the project).\n` +
    '6. Call edgegap_create_app_version with docker_repository "registry.edgegap.com", ' +
    `docker_image "<project>/${image}", docker_tag "${buildTag}", and the same username and ` +
    'token as registry_username/registry_token.\n\n' +
    'Or push to any other registry Edgegap can pull from (Docker Hub, GHCR, ECR, GCR, GitLab) ' +
    'and pass its registry_username/registry_token to edgegap_create_app_version.'
  );
}

/**
 * What edgegap_create_app_version says when Edgegap could not log in to the
 * registry to verify the image. The agent should not be handed the registry
 * login just to get past this, so the dashboard route comes first.
 */
function registryLoginNeeded(repository: string, hadLogin: boolean): string {
  return (
    `Edgegap could not log in to ${repository} to verify the image, so the version was not ` +
    'created. ' +
    (hadLogin
      ? 'The registry_username/registry_token given were rejected: check them.'
      : 'Edgegap pulls images with a registry login set on the version, not your API token — ' +
        'this applies to your own registry.edgegap.com project too.') +
    '\n\nOptions:\n' +
    '1. Create the version again with verify_image false, then have the developer open it in ' +
    `the dashboard (${DASHBOARD_URL}) and add the registry username and token (for ` +
    'registry.edgegap.com, the ones on the Container Registry page). Deployments fail to pull ' +
    'until they do.\n' +
    '2. If the developer chooses to give them to you, pass registry_username and registry_token. ' +
    'They are registry-scoped, not the org API token. Do not write them into files.'
  );
}

/** Trims a relay session down to what a game client integration needs. */
function compactRelay(s: RelaySession) {
  return {
    session_id: s.session_id,
    ready: s.ready ?? false,
    status: s.status,
    error: s.error || undefined,
    session_authorization_token: s.authorization_token,
    relay: s.relay
      ? {
          host: s.relay.host,
          ip: s.relay.ip,
          server_port: s.relay.ports?.server,
          client_port: s.relay.ports?.client,
        }
      : undefined,
    users: (s.session_users ?? []).map((u) => ({
      ip: u.ip_address,
      authorization_token: u.authorization_token,
    })),
    how_to_connect: s.ready
      ? 'Configure the Edgegap relay transport with the relay address, the session authorization ' +
        'token, and each player\'s own authorization token. The host connects on server_port; ' +
        'every other player connects on client_port.'
      : undefined,
    architecture_note:
      'This is a relay, not a game server: the host player\'s game owns the match. If the ' +
      'developer has not explicitly chosen host-client, tell them about the trade-offs. ' +
      ARCHITECTURE_GUIDANCE,
  };
}
