---
description: >-
  Connect AI coding agents to Edgegap through MCP: write and validate your
  server Dockerfile, push the image, deploy dedicated servers, and troubleshoot.
---

# MCP Integration

Connect AI coding agents to Edgegap through our MCP server. Your agent can take a headless server build all the way to players connecting: write or check the Dockerfile, push the image to your private Edgegap registry, deploy an authoritative dedicated server close to players, and read logs when something breaks.

## 👉 Supported Features

{% hint style="success" %}
**Using Unity, Unreal Engine, or Godot?** Our [Unity](/unity.md), [Unreal Engine](/unreal-engine.md), and [Godot](/godot.md) guides and plugins remain the fastest path for those engines. The MCP server works alongside them, and on its own for any engine.
{% endhint %}

Use our MCP server when:

* **Containerizing your game server** - your agent writes a Dockerfile for your build (or checks the one you have) against Edgegap's requirements, then pushes the image to your private Edgegap container registry.
* **Deploying a dedicated server** - create an application and version, deploy close to your players, and get the connection address.
* **Setting up matchmaking** - generate a matchmaker configuration that points at your deployed version, ready to upload in the dashboard.
* **Running a host-client game** - create a relay session if your game is built with one player as host. See [#dedicated-servers-or-relays](#dedicated-servers-or-relays "mention") first.
* **Building a CI/CD pipeline** - test your deployments and teardown from a build system.
* **Troubleshooting a game server issue** - inspect app versions and deployment status, read container logs, or reproduce a failed deployment.

{% hint style="warning" %}
Out of scope / not supported by MCP: creating or running a matchmaker (the MCP generates the configuration, you upload it in the dashboard); server browser; lobbies; managed clusters; private fleets; or billing.
{% endhint %}

{% hint style="info" %}
If you need help, [please reach out to us over Discord](https://discord.gg/MmJf8fWjnt). For live games support see our [ticketing system](https://edgegap.atlassian.net/servicedesk/customer/portal/3).
{% endhint %}

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

{% hint style="info" %}
**No server image yet?** That's not a reason to choose relays. Your agent can write the Dockerfile for your build with `edgegap_generate_dockerfile`. Learn more about relays in [Distributed Relay](/learn/distributed-relay.md).
{% endhint %}

## 🚀 Installation

MCP server installation is very simple:

1. Install the MCP server for [#popular-agents](#popular-agents "mention") or with [#custom-integration](#custom-integration "mention").
2. Generate and attach an API token for your agent to use with our MCP server:

Generate (and view) your secret tokens for Edgegap API in [Dashboard - User Settings / Tokens](https://app.edgegap.com/user-settings?tab=tokens).

Add your secret token with each API request as an HTTP header (include the word `token`):

`Authorization: token xxxxxxxx-e458-4592-b607-c2c28afd8b62`

{% hint style="danger" %}
**Do not integrate Edgegap API endpoints in game client, as your API token provides unlimited access to your account. See** [Integration](/docs/api/integration.md) **for secure client-facing API endpoints and functions.**
{% endhint %}

{% hint style="success" %}
In case your secret tokens are compromised or leaked, delete and re-create them from dashboard.
{% endhint %}

### Popular Agents

Install Edgegap MCP server in your preferred agentic IDE: <a href="cursor://anysphere.cursor-deeplink/mcp/install?name=Edgegap&#x26;config=eyJ1cmwiOiJodHRwczovL21jcC5lZGdlZ2FwLmRldi9tY3AiLCJoZWFkZXJzIjp7IkF1dGhvcml6YXRpb24iOiIifX0%3D" class="button secondary" data-icon="cursor">Cursor</a><a href="vscode:mcp/install?%7B%22name%22%3A%22Edgegap%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.edgegap.dev%2Fmcp%22%2C%22headers%22%3A%7B%22Authorization%22%3A%22%22%7D%7D" class="button secondary" data-icon="vscode">VS Code</a>

#### Claude Code

```bash
claude mcp add --transport http edgegap https://mcp.edgegap.dev/mcp \
  -H "Authorization: token xxxxxxxx-e458-4592-b607-c2c28afd8b62" --scope user
```

#### ChatGPT Codex

```bash
codex mcp add edgegap --url https://mcp.edgegap.dev/mcp
```

#### mcp.json

Most agentic IDEs also support integration by pasting JSON configuration:

{% code title="mcp.json" %}

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

{% endcode %}

### Custom Integration

The official repository is the single source of truth for custom integration of our MCP server:

{% embed url="<https://github.com/edgegap/edgegap-mcp>" %}

Install remote Edgegap MCP server in your agent's virtualized environment (never in your project!):

{% code title="node using npx package" %}

```json
{
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.edgegap.dev/mcp", "--transport", "http-only"]
}
```

{% endcode %}

{% code title="python using uvx package" %}

```json
{
  "command": "uvx",
  "args": ["mcp-proxy", "--transport", "streamablehttp", "https://mcp.edgegap.dev/mcp"]
}
```

{% endcode %}

To keep your API token on your own machine, run the server locally instead. Leave the token out and your agent asks you for it on first use, holding it in memory only for that session:

{% code title="local server using npx" %}

```json
{
  "command": "npx",
  "args": ["-y", "@edgegap/mcp"],
  "env": { "EDGEGAP_API_TOKEN": "xxxxxxxx-e458-4592-b607-c2c28afd8b62" }
}
```

{% endcode %}

The local server also supports `EDGEGAP_READ_ONLY=1` and `EDGEGAP_APP_ALLOWLIST` to limit what an agent can do. See the [repository README](https://github.com/edgegap/edgegap-mcp) for details.

## 🧰 Tools

Your agent picks the right tool from your request. You don't need to name them, but knowing what's available helps you ask.

### Before Your First Deployment

| Tool | What it does |
| --- | --- |
| `edgegap_generate_dockerfile` | Writes a Dockerfile for your server build: your build folder, server binary or start script, ports, and launch arguments, with the right headless flags (Unity `-batchmode -nographics`, Godot `--headless`), a non-root user for Unreal, and matching ports. Lists anything it had to assume so your agent can confirm it. Works for Unity, Unreal Engine, Godot, and any other engine. |
| `edgegap_validate_server_config` | Checks an existing Dockerfile, ports, resources, and image tag before you build. Catches ARM or Windows images (Edgegap runs `linux/amd64`), Unreal servers running as root, missing Unity `-batchmode -nographics`, servers bound to `localhost`, ports that don't match your netcode transport, and the `latest` tag. |
| `edgegap_get_registry_credentials` | Returns push credentials for your private Edgegap container registry, with the exact `docker login`, build, and push commands. No Docker Hub account needed. |
| `edgegap_list_registry_tags` | Confirms your image push landed before you register it. |

### Dedicated Servers (Recommended)

| Tool | What it does |
| --- | --- |
| `edgegap_list_apps` | Lists your applications. |
| `edgegap_create_app` | Creates an application. |
| `edgegap_list_app_versions` | Lists versions with their image, resources, and ports. |
| `edgegap_create_app_version` | Registers a container image as a deployable version. |
| `edgegap_deploy` | Deploys an authoritative dedicated server close to your players. |
| `edgegap_wait_for_deployment` | Waits until the server is ready and returns the connection address. |
| `edgegap_get_deployment` | Reads a deployment's status. |
| `edgegap_list_deployments` | Lists running deployments, to find servers left running. |
| `edgegap_get_deployment_logs` | Reads container logs and crash details. |
| `edgegap_stop_deployment` | Stops one deployment. |

### Matchmaking

| Tool | What it does |
| --- | --- |
| `edgegap_build_matchmaker_config` | Generates a matchmaker configuration (teams, team size, optional latency rules and expansions) and checks that the version it deploys exists. Upload the result in the dashboard to create your matchmaker, which starts a dedicated server for each match. |

Learn more about the configuration in [Matchmaking](/learn/matchmaking.md).

### Relays (Host-Client Games Only)

A relay is not a game server: it forwards traffic while one player's game hosts the match. See [#dedicated-servers-or-relays](#dedicated-servers-or-relays "mention").

| Tool | What it does |
| --- | --- |
| `edgegap_create_relay_session` | Creates a relay session for your players and returns the relay address and each player's authorization token. |
| `edgegap_get_relay_session` | Reads a relay session. |
| `edgegap_authorize_relay_user` | Adds a player who joins later. |
| `edgegap_delete_relay_session` | Closes a relay session. |

{% hint style="warning" %}
Deployments and relay sessions are billed while they run. Ask your agent to stop test deployments and delete test relay sessions when it's done.
{% endhint %}

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

If your agent can't retrieve registry credentials, request them in the [dashboard](https://app.edgegap.com) under **Container Registry**, or push to another registry Edgegap can pull from (Docker Hub, GitHub, AWS ECR, GCP, GitLab). See [External Registries](/docs/tools-and-integrations/docker/external-registries.md).

### Server Starts Locally but Not on Edgegap

Ask your agent to validate your server configuration, or to generate a new Dockerfile. The most common causes are an image built on Apple Silicon without `--platform linux/amd64`, a server listening on a different port than the version exposes, or a UDP transport configured as TCP.

### Other API Errors

Please consult our [API Reference](/docs/api.md) for possible error responses for individual API endpoints.

{% hint style="info" %}
If you need help, [please reach out to us over Discord](https://discord.gg/MmJf8fWjnt). For live games support see our [ticketing system](https://edgegap.atlassian.net/servicedesk/customer/portal/3).
{% endhint %}
