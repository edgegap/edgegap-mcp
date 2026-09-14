# Cloudflare: the trade you are making

**Status: implemented, tested, deployable.** See INSTALL.md for steps. This
document is why you should prefer the local server where you can, not an
argument that the hosted one does not work — it does.

Short version: **no, not for the tools that need a token.** The reason to host
an MCP server is to remove developer setup. Header-based auth does not remove
it — the developer still pastes a token into a config file — so you pay the
cost of routing customer credentials through Edgegap infrastructure and get no
simplicity back.

## What hosting was supposed to buy

A URL instead of an install. No Node, no npm, no JSON config edit.

## Why it does not, here

Without OAuth, a hosted server has to get the token from somewhere. Two options:

1. **Store it server-side.** Edgegap becomes custodian of every customer's
   org-wide Edgegap credential, in one internet-reachable place. Those tokens
   cannot be scoped, so a breach is a breach of every connected customer's
   entire account. Not acceptable.

2. **Take it per request from an `Authorization` header.** Nothing is stored,
   but the token now transits Edgegap infrastructure on every call, and the
   developer is back to pasting a secret into a config file. The setup friction
   you were removing is still there, and you have added credential transit for
   nothing.

Note that "we do not store it" and "we never see it" are different claims. Only
the local process makes the second one.

## Where each one fits

| | Local (`npx -y @edgegap/mcp`) | Hosted Worker |
| --- | --- | --- |
| Token location | Developer's machine only | Transits Edgegap infra per request |
| Token storage | Memory, session lifetime | None — discarded with the request |
| Setup | One config line, or prompted with no config at all | Paste token into client config |
| Web / mobile MCP clients | No | Yes |
| Shared demo URL | No | Yes |

Default to local. Reach for hosted when you need the last two rows.

## What the local server does instead

`npx -y @edgegap/mcp` in the client config. No clone, no build, no manual
install step. If the client supports interactive prompts, the developer is
asked for the token at first use and never touches a config file at all —
which is simpler than the hosted version, not harder.

The token lives in one variable in a process on the developer's own machine,
spawned by their editor, for the life of that editor session. Nothing on disk,
nothing on Edgegap servers, nothing in logs.

## When to revisit

The week Edgegap ships OAuth. At that point `@cloudflare/workers-oauth-provider`
wired to `createMcpHandler` via `apiRoute` / `apiHandler` gives you a genuine
one-URL install: the developer authorises in a browser, the Worker holds a
scoped revocable grant, and no master key exists to leak. That is the version
worth hosting.

`worker.ts` and `wrangler.jsonc` are the starting point for that work. Once
OAuth exists, the `Authorization`-header path in `worker.ts` can be deleted
outright and the hosted server becomes strictly better than the local one.

## Verified facts, so nobody re-derives them

- `agents@0.23.0` exports `createMcpHandler` from `agents/mcp/server`
- pairs with `@modelcontextprotocol/server@2.0.0` (SDK v2, not v1)
- `McpAgent` is deprecated and feature-frozen — ignore tutorials using it
- `server.elicitInput()` throws on the stateless handler: the 2026-07-28
  protocol revision removed the server-to-client request channel. The hosted
  port would need the token prompt rewritten as `inputRequired.elicit(...)`,
  which the handler returns rather than awaits
