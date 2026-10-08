# Edgegap MCP Server

Connect AI coding agents to Edgegap through our MCP server. Your agent can take a headless server build all the way to players connecting: write or check the Dockerfile, push the image to your private Edgegap registry, deploy an authoritative dedicated server close to players, and read logs when something breaks.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=Edgegap&config=eyJ1cmwiOiJodHRwczovL21jcC5lZGdlZ2FwLmRldi9tY3AiLCJoZWFkZXJzIjp7IkF1dGhvcml6YXRpb24iOiIifX0%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Edgegap_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=Edgegap&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.edgegap.dev%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22%22%7D%7D)

## 👉 Supported Features

> [!TIP]
> **Using Unity, Unreal Engine, or Godot?** Our [Unity](https://docs.edgegap.com/unity), [Unreal Engine](https://docs.edgegap.com/unreal-engine), and [Godot](https://docs.edgegap.com/godot) guides and plugins remain the fastest path for those engines. The MCP server works alongside them, and on its own for any engine.

Use our MCP server when:

* **Containerizing your game server** - your agent writes a Dockerfile for your build (or checks the one you have) against Edgegap's requirements, then pushes the image to your private Edgegap container registry.
* **Deploying a dedicated server** - create an application and version, deploy close to your players, and get the connection address.
* **Setting up matchmaking** - generate a matchmaker configuration that points at your deployed version, ready to upload in the dashboard.
* **Running a host-client game** - create a relay session if your game is built with one player as host. See [Dedicated Servers or Relays?](#dedicated-servers-or-relays) first.
* **Building a CI/CD pipeline** - test your deployments and teardown from a build system.
* **Troubleshooting a game server issue** - inspect app versions and deployment status, read container logs, or reproduce a failed deployment.

> [!WARNING]
> Out of scope / not supported by MCP: creating or running a matchmaker (the MCP generates the configuration, you upload it in the dashboard); server browser; lobbies; managed clusters; private fleets; or billing.

> [!NOTE]
> If you need help, [please reach out to us over Discord](https://discord.gg/MmJf8fWjnt). For live games support see our [ticketing system](https://edgegap.atlassian.net/servicedesk/customer/portal/3).

<a id="dedicated-servers-or-relays"></a>

## ⚖️ Dedicated Servers or Relays?

Edgegap can host your multiplayer game in two ways. **We recommend dedicated servers**, and so does our MCP server: your agent will default to a dedicated server and only use a relay when you've chosen a host-client setup.

|                         | Dedicated server (recommended)                   | Relay                                                     |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| What Edgegap runs       | Your headless server build, close to players     | A traffic forwarder only, no game code                    |
| Who runs the game       | The server                                       | One player's game (the host)                              |
| Cheating                | Much harder, the server has authority            | The host can change anything                              |
| Fairness                | Every player connects directly to the server     | The host has no latency, everyone else goes through two hops |
| When the host leaves    | The match continues                              | The match ends, unless your game supports host migration  |
| Performance limited by  | The server's allocated CPU and memory            | The host's PC and home internet upload                    |
| You need                | A server build in a container image              | Netcode built as a listen server (host-client)            |

> [!NOTE]
> **No server image yet?** That's not a reason to choose relays. Your agent can write the Dockerfile for your build with `edgegap_generate_dockerfile`. Learn more about relays in [Distributed Relay](https://docs.edgegap.com/learn/distributed-relay).

## 🚀 Installation

MCP server installation is very simple:

1. Install the MCP server for [Popular Agents](#popular-agents) or with [Custom Integration](#custom-integration).
2. Generate and attach an API token for your agent to use with our MCP server.

Generate (and view) your secret tokens for Edgegap API in [Dashboard - User Settings / Tokens](https://app.edgegap.com/user-settings?tab=tokens).

Add your secret token with each API request as an HTTP header (include the word `token`):

`Authorization: token xxxxxxxx-e458-4592-b607-c2c28afd8b62`

> [!CAUTION]
> **Do not integrate Edgegap API endpoints in game client, as your API token provides unlimited access to your account. See [Integration](https://docs.edgegap.com/docs/api/integration) for secure client-facing API endpoints and functions.**

> [!TIP]
> In case your secret tokens are compromised or leaked, delete and re-create them from dashboard.

The token is organization-wide and cannot be scoped to one application. Read [DESIGN.md](DESIGN.md#where-your-token-goes) before giving it to an unattended agent.

### Popular Agents

Install Edgegap MCP server in your preferred agentic IDE with the **Cursor** or **VS Code** buttons at the top of this page, then add your token to the `Authorization` header.

#### Claude Code

```bash
claude mcp add --transport http edgegap https://mcp.edgegap.dev/mcp \
  -H "Authorization: token xxxxxxxx-e458-4592-b607-c2c28afd8b62" --scope user
```

#### ChatGPT Codex

```bash
codex mcp add edgegap --url https://mcp.edgegap.dev/mcp
```

#### claude.ai

Add `https://mcp.edgegap.dev/mcp` as a custom connector and supply the same token.

#### mcp.json

Most agentic IDEs also support integration by pasting JSON configuration:

```json
{
    "mcpServers": {
        "Edgegap": {
            "type": "http",
            "url": "https://mcp.edgegap.dev/mcp",
            "headers": {
                "Authorization": "token xxxxxxxx-e458-4592-b607-c2c28afd8b62"
            }
        }
    }
}
```

### Custom Integration

Install remote Edgegap MCP server in your agent's virtualized environment (never in your project!):

**Node, using the `mcp-remote` npx package**

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.edgegap.dev/mcp", "--transport", "http-only"]
}
```

**Python, using the `mcp-proxy` uvx package**

```json
{
  "command": "uvx",
  "args": ["mcp-proxy", "--transport", "streamablehttp", "https://mcp.edgegap.dev/mcp"]
}
```

### Local Server

To keep your API token on your own machine, run the server locally instead. Leave the token out and your agent asks you for it on first use, holding it in memory only for that session:

```json
{
  "mcpServers": {
    "Edgegap": {
      "command": "npx",
      "args": ["-y", "@edgegap/mcp"],
      "env": { "EDGEGAP_API_TOKEN": "xxxxxxxx-e458-4592-b607-c2c28afd8b62" }
    }
  }
}
```

Needs Node 18+. Pin a version in production (`@edgegap/mcp@0.3.2`) rather than floating on latest. Registered in the official MCP registry as `dev.edgegap/mcp`.

The local server can also limit what an agent can do. These variables have no effect on the hosted endpoint at `mcp.edgegap.dev`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGEGAP_API_TOKEN` | *(prompted)* | API token. Optional: omit it and you're asked at first use. The `token ` prefix is added for you. Never pass it as a command-line argument. |
| `EDGEGAP_READ_ONLY` | `0` | Set to `1` and the eight mutating tools are never registered, so the agent cannot be talked into calling them. |
| `EDGEGAP_APP_ALLOWLIST` | *(empty)* | Comma-separated application names. Limits what the agent can create and deploy into, not what it can touch once running. See [DESIGN.md](DESIGN.md#scope-of-the-allowlist). |
| `EDGEGAP_MAX_DURATION_MINUTES` | `60` | Ceiling on `max_duration` the agent may set on a version. |
| `EDGEGAP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout. |

## 🧰 Tools

Your agent picks the right tool from your request. You don't need to name them, but knowing what's available helps you ask. Tools marked ● change something in your account and are hidden when `EDGEGAP_READ_ONLY=1`.

### Before Your First Deployment

| Tool | What it does |
| --- | --- |
| `edgegap_generate_dockerfile` | Writes a Dockerfile for your server build: your build folder, server binary or start script, ports, and launch arguments, with the right headless flags (Unity `-batchmode -nographics`, Godot `--headless`), a non-root user for Unreal, and matching ports. Lists anything it had to assume so your agent can confirm it. Works for Unity, Unreal Engine, Godot, and any other engine. |
| `edgegap_validate_server_config` | Checks an existing Dockerfile, ports, resources, and image tag before you build. Catches ARM or Windows images (Edgegap runs `linux/amd64`), Unreal servers running as root, missing Unity `-batchmode -nographics`, servers bound to `localhost`, ports that don't match your netcode transport, and the `latest` tag. |
| `edgegap_get_registry_credentials` ● | Returns push credentials for your private Edgegap container registry, with the exact `docker login`, build, and push commands. Edgegap only gives these to the Unity/Unreal plugins' quick-start token; with a regular API token, it tells your agent to ask you for the login from the dashboard's **Container Registry** page instead. |
| `edgegap_list_registry_tags` | Confirms your image push landed before you register it. Takes the image name only, e.g. `my-game-server`: the project comes from your token. |

### Dedicated Servers (Recommended)

| Tool | What it does |
| --- | --- |
| `edgegap_list_apps` | Lists your applications. |
| `edgegap_create_app` ● | Creates an application. |
| `edgegap_list_app_versions` | Lists versions with their image, resources, and ports. |
| `edgegap_create_app_version` ● | Registers a container image as a deployable version. |
| `edgegap_deploy` ● | Deploys an authoritative dedicated server close to your players. |
| `edgegap_wait_for_deployment` | Waits until the server is ready and returns the connection address. |
| `edgegap_get_deployment` | Reads a deployment's status. |
| `edgegap_list_deployments` | Lists running deployments, filtered by application, version, status, tags and more, and sorted by age. Finds servers left running. See [Filter Deployments](https://docs.edgegap.com/learn/orchestration/deployments#filter-deployments). |
| `edgegap_get_deployment_logs` | Reads container logs and crash details. |
| `edgegap_stop_deployment` ● | Stops one deployment. |

### Matchmaking

| Tool | What it does |
| --- | --- |
| `edgegap_build_matchmaker_config` | Generates a matchmaker configuration (teams, team size, optional latency rules and expansions) and checks that the version it deploys exists. Upload the result in the dashboard to create your matchmaker, which starts a dedicated server for each match. |

Learn more about the configuration in [Matchmaking](https://docs.edgegap.com/learn/matchmaking).

### Relays (Host-Client Games Only)

A relay is not a game server: it forwards traffic while one player's game hosts the match. See [Dedicated Servers or Relays?](#dedicated-servers-or-relays).

| Tool | What it does |
| --- | --- |
| `edgegap_create_relay_session` ● | Creates a relay session for your players and returns the relay address and each player's authorization token. |
| `edgegap_get_relay_session` | Reads a relay session. |
| `edgegap_authorize_relay_user` ● | Adds a player who joins later. |
| `edgegap_delete_relay_session` ● | Closes a relay session. |

> [!WARNING]
> Deployments and relay sessions are billed while they run. Ask your agent to stop test deployments and delete test relay sessions when it's done.

### Example Prompts

* *"Write a Dockerfile for my Unity server build, then push it and deploy a server near me."*
* *"Check my Dockerfile for Edgegap and fix any problems."*
* *"Create a matchmaker config for 2v2 matches on my latest version."*
* *"My deployment failed. Read the logs and tell me why."*
* *"My game uses host-client networking. Set up an Edgegap relay for two players."*

## 🚨 Troubleshooting

Review common error codes and learn how to unlock your integration.

### 401 Unauthorized

Your MCP integration is most likely not including the Authorization header correctly.

### 403 Forbidden

Your MCP integration is likely using the template token or a deleted token. Please validate that the token value used by your integration matches exactly the token displayed in dashboard.

### 424 Image Could Not Be Pulled

Edgegap could not pull your container image. Check the repository, image name, and tag, and that the tag was pushed (ask your agent to list registry tags). For images in the Edgegap registry, the image name must include your project, e.g. `my-project/my-game-server`.

### Registry Credentials Unavailable

Edgegap only gives registry credentials to the quick-start token the Unity and Unreal plugins use, so with a regular API token your agent can't retrieve them and asks you instead. Copy the Project, Username and Token from the [dashboard](https://app.edgegap.com) under **Container Registry**, or push to another registry Edgegap can pull from (Docker Hub, GitHub, AWS ECR, GCP, GitLab). See [External Registries](https://docs.edgegap.com/docs/tools-and-integrations/docker/external-registries).

### Server Starts Locally but Not on Edgegap

Ask your agent to validate your server configuration, or to generate a new Dockerfile. The most common causes are an image built on Apple Silicon without `docker build --platform linux/amd64`, a server listening on a different port than the version exposes, or a UDP transport configured as TCP.

### Other API Errors

Please consult our [API Reference](https://docs.edgegap.com/docs/api) for possible error responses for individual API endpoints.

> [!NOTE]
> If you need help, [please reach out to us over Discord](https://discord.gg/MmJf8fWjnt). For live games support see our [ticketing system](https://edgegap.atlassian.net/servicedesk/customer/portal/3).

## 🛠️ Self-Hosting

The hosted endpoint at `mcp.edgegap.dev` runs as a Cloudflare Worker (see [worker/INSTALL.md](worker/INSTALL.md)). To run the same stateless HTTP server on your own infrastructure, use the Docker image:

```bash
docker build -t edgegap-mcp .
docker run --rm -p 8080:8080 edgegap-mcp
```

Clients connect to `http://<host>:8080/mcp` with their own `Authorization` header, the same way they connect to the hosted endpoint. The image holds no credential, and `/health` answers without one. `PORT`, `HOST`, `EDGEGAP_READ_ONLY`, `EDGEGAP_APP_ALLOWLIST` and `EDGEGAP_MAX_DURATION_MINUTES` apply. Read [worker/DECISION.md](worker/DECISION.md) before exposing it beyond a private network.

Prebuilt images are published to `ghcr.io/edgegap/edgegap-mcp`, tagged `main` and `sha-<commit>` on every push to `main`, plus the version on `v*` tags:

```bash
docker run --rm -p 8080:8080 ghcr.io/edgegap/edgegap-mcp:main
```

## Development

```bash
npm ci
npm run build
npm test                  # mock-API tests; none reach Edgegap
npm run typecheck:worker
```

| Test | Covers |
| --- | --- |
| `test/smoke.mjs` | Handshake, tool registration, read-only mode |
| `test/guards.mjs` | Local validation and allowlist enforcement |
| `test/elicit.mjs` | Token prompt: accept, refuse acknowledgement, decline, no support |
| `test/newtools.mjs` | Validator, Dockerfile generator, registry, deployments, relay and matchmaker tools against a local mock API |
| `test/http.mjs` | Self-hosted HTTP server: discovery without a token, per-request tokens, foreign credentials |
| `test/live-check.mjs` | Not in `npm test`. Runs against the real API with a token from a non-production organization |

Design decisions, the security model, and what's deliberately out of scope are in [DESIGN.md](DESIGN.md).
