# Design

Why the Edgegap MCP server is built the way it is: where the API token goes, what the guardrails do and do not cover, and what is deliberately left out. User-facing setup is in [README.md](README.md).

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

**Self-hosted.** The Docker image (`src/http.ts`) works like the remote
endpoint, except the token transits whoever runs the container instead of
Edgegap. It holds no credential of its own and ignores `EDGEGAP_API_TOKEN`.

Generate a token at <https://app.edgegap.com/user-settings?tab=tokens>.

In local mode, setting `EDGEGAP_API_TOKEN` takes precedence over the prompt,
for CI and for clients that cannot show prompts. Do not pass a token as a
command-line argument — arguments are visible to other processes via `ps`, and
the server warns if it detects one.

**Which to use.** Remote for a first try, a demo, or a supervised session where
setup friction matters more than custody. Local for anything unattended,
anything in an organization with a live game in it, and anything where you
would rather not extend trust you don't have to. The guardrails described below
exist only where you set the environment: local mode, or a self-hosted copy.

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

`EDGEGAP_APP_ALLOWLIST` is enforced by the five tools that take an application
name: `edgegap_create_app`, `edgegap_list_app_versions`,
`edgegap_create_app_version`, `edgegap_deploy`, and
`edgegap_build_matchmaker_config`.

Relay sessions and the container registry belong to the organization, not to an
application, so the relay and registry tools are not covered by it either.

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
the mutating tools at all, or point the agent at a separate non-production
organization. Both are unaffected by this gap.

Reported by Syed Anas Mohiuddin, September 2026.

## Why relays are not the default

The server recommends a dedicated server by default, and tells the agent so in its instructions, in the tool descriptions, and in every relay result. See the comparison in the [README](README.md#dedicated-servers-or-relays).

Agents left alone tend to pick relays because they need no server image. That
saves the agent work, not the developer's game, so the relay tool tells the
agent to use it only when the developer has chosen host-client, or the netcode
is already a listen server and moving to a dedicated server is not an option —
and to ask when that is unclear.

## Design decisions

**Curated, not generated.** The Edgegap API has roughly sixty operations.
Auto-generating one tool per operation puts all sixty descriptions into the
agent's context on every turn and measurably degrades tool selection. These
cover the path that converts a new developer — including the steps before the
first deploy, which are where that path used to end.

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
`edgegap_validate_server_config` extends this to the image itself, before a
build and push are spent discovering a problem.

**Generated Dockerfiles are validated before they are returned.**
`edgegap_generate_dockerfile` runs its own output through
`edgegap_validate_server_config` and refuses to return anything that fails, so
the two tools cannot disagree. Every value it writes into the Dockerfile (paths,
binary name, launch arguments) is restricted to characters that cannot start a
new instruction or escape into a shell. The Unity template leaves out the `env`
dump from Edgegap's plugin Dockerfile, which writes hidden environment variables
into container logs.

**The same instructions on every transport.** The hosted Worker used to start
without server instructions, so hosted agents never saw the golden path. All
three entry points (`src/index.ts`, `src/http.ts`, `worker/worker.ts`) use
`serverInstructions()` from `src/tools.ts`.

**The registry token is handed to the agent; the API token never is.** The agent
has to run `docker login`, so the registry token is returned in the tool result.
It is scoped to the org's registry project, and the returned command reads it
from an environment variable over `--password-stdin` so it stays off command
lines and out of shell history. The tool is hidden in read-only mode.

**The registry credentials endpoint is not in the public spec, and only
accepts quick-start tokens.** It is `GET /v1/wizard/registry-credentials`, the
Unity plugin's quick-start call. A regular API token gets 403 "This token is not
a quick start token" (verified 2026-10-08), so for almost every developer the
tool cannot fetch credentials. On 403 it returns the manual path instead
(dashboard Container Registry page, or another registry), and it never calls
`POST /v1/wizard/init-quick-start`, which answers a regular token with a second,
more confusing 403. Provisioning runs only on a 404, for a quick-start token
whose project does not exist yet. Making this work for regular tokens needs a
backend change, and is a product decision: it would let an org-wide token hand
out push credentials.

**Registry tag listing takes the image name only.** The API reads the project
from the token, so `/v1/container-registry/images/<project>/<image>/tags` is a
404. The tool tries the name as given first (nested image names are valid),
then retries without a leading `<project>/`, and strips a registry host or tag
if the agent passes a full image reference.

**Bulk operations are deliberately absent.** `stop` takes one `request_id`.
There is no bulk-stop tool, because an agent with a filter expression and a bug
can stop a production fleet.

**Both a hosted endpoint and a local package.** The hosted endpoint removes
every step between finding this server and calling a tool, which is where most
developers drop out. The local package is the only way to run the server
without extending custody of an unscoped token to a third party, including us.
Neither one dominates the other, so both ship. See `worker/DECISION.md` for the
longer version.

**One hosted design, two runtimes.** `src/http.ts` is the Worker's stateless
design on plain Node, for hosts that are not Cloudflare (the Docker image, a
VM next to another service). Both read the token from each request through
`src/hosted.ts`, ignore any token in the environment, and answer discovery
without one, so the two cannot drift on who holds a credential.

**Deployment filters are structured, not free text.** `edgegap_list_deployments`
takes `filters` and `order_by` as typed fields and builds the JSON query the
API expects, so an agent that only saw the OpenAPI spec cannot send a filter
the API rejects. The field and operator lists come from the
[filtering guide](https://docs.edgegap.com/learn/orchestration/deployments#filter-deployments).

## Scope

Not exposed, on purpose: private fleets, smart fleets, endpoint storage,
ACL/whitelist entries, deployment tags, metrics, registry tag deletion, DNS
configuration, and matchmaker lifecycle (start, stop, delete).

These belong to studios already operating on the platform, not to a developer
getting a first game online. Dockerfile generation and validation, registry
push, a basic matchmaker config, and relays were moved in scope because agents
hit them before the first deploy, not after.

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
