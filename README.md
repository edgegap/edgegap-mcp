# edgegap-mcp

An MCP server for Edgegap that lets a coding agent take a developer from "I
have a game server container" to "players are connected to it" without the
developer reading the API reference.

Ten tools, hand-picked. Not generated from the OpenAPI spec — see
[Scope](#scope) for why.

## Install

One line in your MCP client config. Nothing to clone, nothing to build.

```json
{
  "mcpServers": {
    "edgegap": {
      "command": "npx",
      "args": ["-y", "@edgegap/mcp"]
    }
  }
}
```

Works in Claude Code, Cursor, Codex, and VS Code. Pin a version in production
(`@edgegap/mcp@0.1.0`) rather than floating on latest.

Registered in the official MCP registry as `dev.edgegap/mcp`.

> **Node version:** the server itself needs Node 18+. Deploying the optional
> Cloudflare Worker needs Node 22+, because `wrangler` requires it.

## Your token never leaves your machine

There is no Edgegap-hosted component. This server runs as a process on your
own computer, spawned by your editor. The first tool call asks you for a token,
shows what it authorises, and requires an explicit acknowledgement before
accepting it. Where that token then lives, exhaustively:

- one variable in that process's memory, for the life of your editor session

That is the whole list. Not on disk. Not in a config file. Not in logs. Not on
any Edgegap server — the only thing sent to Edgegap is the API call itself,
exactly as if you had run `curl`. Closing your editor revokes this server's
access completely.

Generate a token at <https://app.edgegap.com/user-settings?tab=tokens>.

Setting `EDGEGAP_API_TOKEN` still works and takes precedence, for CI and for
clients that cannot show prompts. Do not pass a token as a command-line
argument — arguments are visible to other processes via `ps`, and the server
warns if it detects one.

**Why this is not hosted.** A hosted server would have to either store your
token or receive it on every request. "We don't store it" and "we never see it"
are different claims, and only a local process makes the second one. See
`worker/DECISION.md` for the full reasoning and the conditions under which a
hosted version becomes worth building.

## Read this before connecting an agent

**The Edgegap API token cannot be scoped.** One token authorises every
application, every version, every running deployment, and your usage across the
whole organization. There is no deploy-only token and no per-application token.

Consequences worth being deliberate about:

- An agent holding this token can stop production deployments, not just the
  test ones it created.
- Prompt injection reaching the agent — from a repo file, an issue, a fetched
  page — reaches the token too.
- Anything the agent logs, echoes, or sends to a model provider is a place the
  token could end up. This server does not log it, but it cannot control what
  the rest of the agent does.

Recommended setup, in decreasing order of caution:

| Situation | Setup |
| --- | --- |
| Unattended or autonomous agent | Separate non-production organization, plus `EDGEGAP_READ_ONLY=1` |
| Supervised agent, live game in the org | `EDGEGAP_APP_ALLOWLIST` scoped to the app being worked on, plus `EDGEGAP_MAX_DURATION_MINUTES` |
| Solo developer, no production workload | Defaults are fine; revoke the token when finished |

The allowlist and read-only flag are enforced in this server, which means they
protect against an agent that makes a mistake, not against one that has been
compromised into calling the API directly. They narrow the blast radius; they
do not remove it.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGEGAP_API_TOKEN` | *(prompted)* | API token. Optional — omit it and the developer is asked at first use. The `token ` prefix is added for you. |
| `EDGEGAP_READ_ONLY` | `0` | Set to `1` and the five mutating tools are never registered. The agent cannot see them, so it cannot be talked into calling them. |
| `EDGEGAP_APP_ALLOWLIST` | *(empty)* | Comma-separated application names. When set, every tool refuses to touch anything else. |
| `EDGEGAP_MAX_DURATION_MINUTES` | `60` | Ceiling on `max_duration` the agent may set on a version. Caps runaway cost from an unattended agent. |
| `EDGEGAP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout. |

## Tools

Ten tools, listed in the order they fall along the golden path.

| Tool | Mutating | What it's for |
| --- | --- | --- |
| `edgegap_list_apps` | | Orient before doing anything. Prevents duplicate applications. |
| `edgegap_create_app` | ● | Create the container for versions. |
| `edgegap_list_app_versions` | | Find a deployable version, or copy settings from a working one. |
| `edgegap_create_app_version` | ● | Register a container image with CPU, memory, and ports. |
| `edgegap_deploy` | ● | Start one instance near specified players. |
| `edgegap_get_deployment` | | Single status read. |
| `edgegap_wait_for_deployment` | | Poll to ready with backoff, then return the connection address. |
| `edgegap_list_deployments` | | Find orphaned servers from earlier sessions. |
| `edgegap_stop_deployment` | ● | Graceful SIGTERM, one deployment at a time. |
| `edgegap_get_deployment_logs` | | Container output and crash exit code after a failure. |

## Design decisions

**Curated, not generated.** The Edgegap API has roughly sixty operations.
Auto-generating one tool per operation puts all sixty descriptions into the
agent's context on every turn and measurably degrades tool selection. These ten
cover the path that converts a new developer.

**`wait_for_deployment` is a tool, not a loop.** Left to itself an agent will
call a status endpoint in a tight loop, burn turns, and give up early. Folding
the polling and backoff into one call removes the most common failure in
agent-driven deploys.

**Errors are written for self-correction.** A 424 comes back saying the image
could not be pulled and which fields to check. A 422 says to try different
coordinates or lower the resource request. The agent can act on these without a
round trip to the human.

**Local validation before the wire.** The memory-to-CPU ratio and the missing
player location are caught here rather than surfacing as an opaque 400.

**Bulk operations are deliberately absent.** `stop` takes one `request_id`.
There is no bulk-stop tool, because an agent with a filter expression and a bug
can stop a production fleet.

## Scope

Not exposed, on purpose: matchmaking, relays, private fleets, smart fleets,
endpoint storage, ACL/whitelist entries, deployment tags, metrics, container
registry management, DNS configuration.

These are real capabilities, but they belong to studios already operating on
the platform, not to a developer deploying their first server. Adding them
would trade the conversion path for surface area.

## Known limitation: asking for the token at all

The MCP specification says servers should not use elicitation to collect
sensitive data, and an API token is sensitive. This server does it anyway,
because requiring a token in a config file before anything works is the largest
drop in the onboarding funnel, and the whole point of the server is to remove
setup friction.

That is a deliberate trade rather than a pattern to copy. What makes it
defensible is the set of mitigations in `src/auth.ts` — memory-only storage,
plain-language disclosure, required acknowledgement, redaction from all output,
and the environment variable always winning when present. Removing any of them
breaks the trade.

The real fix is on Edgegap's side: scoped, revocable, deploy-only credentials,
issued through OAuth rather than pasted as a secret. Until those exist, the
interactive prompt is a workaround and is labelled as one in the code.

## Development

```bash
npm run typecheck
node smoke.mjs      # handshake, tool registration, read-only mode
node guards.mjs     # local validation and allowlist enforcement
node elicit.mjs     # token prompt: accept, refuse acknowledgement, decline, no support
```

None of these make network calls. `elicit.mjs` asserts that the prompt states
the org-wide scope, that the acknowledgement is required, that the token never
appears in tool output, and that declining produces a stop-and-report message
rather than a retry loop.
