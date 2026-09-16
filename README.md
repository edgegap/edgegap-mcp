# edgegap-mcp

An MCP server for Edgegap that lets a coding agent take a developer from "I
have a game server container" to "players are connected to it" without the
developer reading the API reference.

Ten tools, hand-picked. Not generated from the OpenAPI spec — see
[Scope](#scope) for why.

## Install

Two ways to run it. Pick based on how much you care about where your token
goes — see [Where your token goes](#where-your-token-goes).

### Remote endpoint

Hosted by Edgegap as a Cloudflare Worker. Nothing to install.

```json
{
  "mcpServers": {
    "edgegap": {
      "type": "http",
      "url": "https://mcp.edgegap.dev/mcp",
      "headers": { "Authorization": "token YOUR_API_TOKEN" }
    }
  }
}
```

Also works as a custom connector in claude.ai: add
`https://mcp.edgegap.dev/mcp` and supply the same token.

### Local

Runs on your own machine, spawned by your editor. One line in your MCP client
config, nothing to clone, nothing to build.

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
(`@edgegap/mcp@0.1.5`) rather than floating on latest.

Registered in the official MCP registry as `dev.edgegap/mcp`.

> **Node version:** the local server needs Node 18+. Deploying your own copy of
> the Cloudflare Worker needs Node 22+, because `wrangler` requires it.

## Where your token goes

This differs by mode, and the difference is the reason both modes exist.

**Local.** The server runs as a process on your own computer. The first tool
call asks you for a token, shows what it authorises, and requires an explicit
acknowledgement before accepting it. Where that token then lives, exhaustively:

- one variable in that process's memory, for the life of your editor session

That is the whole list. Not on disk. Not in a config file. Not in logs. Not on
any Edgegap server — the only thing sent to Edgegap is the API call itself,
exactly as if you had run `curl`. Closing your editor revokes this server's
access completely.

**Remote.** Your token is sent to `mcp.edgegap.dev` on every request and
forwarded from there to the Edgegap API. It transits infrastructure Edgegap
operates. The worker holds it for the life of the request and does not persist
it, but that is a "we don't store it" claim rather than a "we never see it"
claim. The two are different, and only local mode makes the second one.

Generate a token at <https://app.edgegap.com/user-settings?tab=tokens>.

In local mode, setting `EDGEGAP_API_TOKEN` takes precedence over the prompt,
for CI and for clients that cannot show prompts. Do not pass a token as a
command-line argument — arguments are visible to other processes via `ps`, and
the server warns if it detects one.

**Which to use.** Remote for a first try, a demo, or a supervised session where
setup friction matters more than custody. Local for anything unattended,
anything in an organization with a live game in it, and anything where you
would rather not extend trust you don't have to. The guardrails described below
exist only in local mode.

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
- On the remote endpoint, the same unscoped token is additionally handled by
  Edgegap's worker on every call.

Recommended setup, in decreasing order of caution:

| Situation | Setup |
| --- | --- |
| Unattended or autonomous agent | Local mode. Separate non-production organization, plus `EDGEGAP_READ_ONLY=1` |
| Supervised agent, live game in the org | Local mode. `EDGEGAP_APP_ALLOWLIST` scoped to the app being worked on, plus `EDGEGAP_MAX_DURATION_MINUTES`. Read [Scope of the allowlist](#scope-of-the-allowlist) first — deployments that are already running are not covered |
| Solo developer, no production workload | Either mode. Defaults are fine; revoke the token when finished |

The allowlist and read-only flag are enforced in the local server, which means
they protect against an agent that makes a mistake, not against one that has
been compromised into calling the API directly. They narrow the blast radius;
they do not remove it.

### Scope of the allowlist

`EDGEGAP_APP_ALLOWLIST` is enforced by the four tools that take an application
name: `edgegap_create_app`, `edgegap_list_app_versions`,
`edgegap_create_app_version`, and `edgegap_deploy`.

It is **not** enforced by the five tools keyed on `request_id`:
`edgegap_get_deployment`, `edgegap_wait_for_deployment`,
`edgegap_list_deployments`, `edgegap_stop_deployment`, and
`edgegap_get_deployment_logs`. An agent running with an allowlist set can list
every deployment in the organization and then inspect, read the logs of, or stop
any of them — including deployments belonging to applications outside the list.

So the allowlist scopes what an agent can **create and deploy into**, not what it
can **touch once running**. That is narrower than earlier versions of this
document implied.

For a stronger guarantee today, use `EDGEGAP_READ_ONLY=1`, which never registers
the five mutating tools at all, or point the agent at a separate non-production
organization. Both are unaffected by this gap.

Reported by Syed Anas Mohiuddin, September 2026.

### Environment variables

These configure the local server. On the remote endpoint they are set by
Edgegap and cannot be changed per developer — if you need any of them, run
locally.

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGEGAP_API_TOKEN` | *(prompted)* | API token. Optional — omit it and the developer is asked at first use. The `token ` prefix is added for you. |
| `EDGEGAP_READ_ONLY` | `0` | Set to `1` and the five mutating tools are never registered. The agent cannot see them, so it cannot be talked into calling them. |
| `EDGEGAP_APP_ALLOWLIST` | *(empty)* | Comma-separated application names. When set, the four application-keyed tools refuse to touch anything else. Does **not** scope the five `request_id`-keyed tools — see [Scope of the allowlist](#scope-of-the-allowlist). |
| `EDGEGAP_MAX_DURATION_MINUTES` | `60` | Ceiling on `max_duration` the agent may set on a version. Caps runaway cost from an unattended agent. |
| `EDGEGAP_TIMEOUT_MS` | `30000` | Per-request HTTP timeout. |

## Tools

Ten tools, listed in the order they fall along the golden path. The same ten in
both modes.

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

**Both a hosted endpoint and a local package.** The hosted endpoint removes
every step between finding this server and calling a tool, which is where most
developers drop out. The local package is the only way to run the server
without extending custody of an unscoped token to a third party, including us.
Neither one dominates the other, so both ship. See `worker/DECISION.md` for the
longer version.

## Scope

Not exposed, on purpose: matchmaking, relays, private fleets, smart fleets,
endpoint storage, ACL/whitelist entries, deployment tags, metrics, container
registry management, DNS configuration.

These are real capabilities, but they belong to studios already operating on
the platform, not to a developer deploying their first server. Adding them
would trade the conversion path for surface area.

## Known limitation: asking for the token at all

This applies to local mode, where the token is collected through elicitation
rather than read from config.

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

The real fix is on Edgegap's side and would improve both modes: scoped,
revocable, deploy-only credentials, issued through OAuth rather than pasted as
a secret. Until those exist, the interactive prompt is a workaround and is
labelled as one in the code.

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
