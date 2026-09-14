# Installing the Edgegap MCP server on Cloudflare

## The whole checklist

Nine steps, in order. Everything below this section is detail on each one.

| # | Step | Command |
| --- | --- | --- |
| 0 | Get the code onto your machine | download / `git clone`, then `cd edgegap-mcp` |
| 1 | Have **Node 22+** and a Cloudflare account | `node -v` |
| 2 | Install dependencies | `npm install` |
| 3 | Typecheck the Worker | `npm run typecheck:worker` |
| 4 | Get an Edgegap API token | dashboard → User Settings → Tokens |
| 5 | Run it locally and test | `npm run worker:dev` |
| 6 | Check the bundle without publishing | `npm run worker:check` |
| 7 | Log in to Cloudflare | `npx wrangler login` |
| 8 | Deploy | `npm run worker:deploy` |
| 9 | Point a client at the URL | see step 9 below |

If everything is already installed, it is steps 7 and 8 — two commands.

---

Every command here was run against the actual code in this repo. The Worker
bundles at 1.2 MiB (213 KiB gzipped), well inside Workers limits, and serves
all ten tools over Streamable HTTP.

Read `DECISION.md` first if you have not. Short version of the trade: tokens
transit Edgegap infrastructure on this path and do not on the local one.

## 0. Get the code

The repo needs to be on the machine you are deploying from. `wrangler` uploads
from your local filesystem — there is no Cloudflare-side build step to point at
a URL.

```bash
cd edgegap-mcp
ls           # expect: src/  worker/  package.json  README.md
```

## 1. Prerequisites

- **Node 22 or newer** (`node -v`) for anything in this guide. `wrangler` and
  `miniflare` both declare `node >=22.0.0` and refuse to start below it, with a
  clear error rather than a confusing failure.

  Note this is stricter than the local stdio server, which runs fine on Node 18.
  If you use `nvm`, `nvm install 22 && nvm use 22` before deploying.

  The deployed Worker itself has no Node requirement — this is purely about the
  build and deploy tooling on your machine.
- **A Cloudflare account.** The free plan is enough — 100,000 requests/day, and
  this Worker uses no Durable Objects, KV, or D1.
- **An Edgegap account** with an API token you can test against.

## 2. Install dependencies

From the repo root:

```bash
npm install
```

Pulls `agents@0.23.0`, `@modelcontextprotocol/server@2.0.0`, `wrangler`, and
`@cloudflare/workers-types`. All four are already in `package.json`; there is
nothing extra to add by hand.

## 3. Typecheck

```bash
npm run typecheck:worker
```

Clean output means the shared `src/` tools compile against Workers types.

## 4. Get an Edgegap API token

Dashboard → User Settings → Tokens:
<https://app.edgegap.com/user-settings?tab=tokens>

You need it to test in the next step, and every developer connecting to the
deployed Worker needs their own. The Worker never holds one of its own.

## 5. Test locally before deploying

```bash
npm run worker:dev
```

In another terminal:

```bash
# Health check — no token required
curl http://127.0.0.1:8787/health
# → ok

# Auth gate
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' -d '{}'
# → 401

# Full handshake (all four headers matter — Accept must include
# text/event-stream or the response body comes back empty)
curl -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H 'Authorization: Bearer YOUR_EDGEGAP_TOKEN' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# Tool list
curl -X POST http://127.0.0.1:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -H 'Authorization: Bearer YOUR_EDGEGAP_TOKEN' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

You should see ten `edgegap_*` tools.

A harmless warning about `Request.cf` appears under `wrangler dev --local`. It
is a local-emulation artifact and does not occur when deployed.

## 6. Check the bundle without publishing

```bash
npm run worker:check
```

Expect `Total Upload: ~1232 KiB / gzip: ~213 KiB` and `--dry-run: exiting now.`
Nothing is published.

## 7. Log in to Cloudflare

```bash
npx wrangler login
```

Opens a browser for OAuth. One time per machine. For CI, set a
`CLOUDFLARE_API_TOKEN` environment variable instead.

## 8. Deploy

```bash
npm run worker:deploy
```

The endpoint lands at `https://edgegap-mcp.<account>.workers.dev/mcp`.

For a branded URL, add a custom domain in the Cloudflare dashboard under
Workers & Pages → your Worker → Settings → Domains & Routes, e.g.
`mcp.edgegap.dev`. Use that in anything customer-facing.

## 9. Connect a client

Clients supporting remote MCP with headers:

```json
{
  "mcpServers": {
    "edgegap": {
      "url": "https://mcp.edgegap.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_EDGEGAP_TOKEN" }
    }
  }
}
```

Clients that only speak stdio, via the `mcp-remote` proxy:

```json
{
  "mcpServers": {
    "edgegap": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.edgegap.dev/mcp",
               "--header", "Authorization:Bearer YOUR_EDGEGAP_TOKEN"]
    }
  }
}
```

## 10. Operational settings

Set in `wrangler.jsonc` under `vars`, or per environment:

| Variable | Effect |
| --- | --- |
| `EDGEGAP_READ_ONLY` | `"1"` serves only the six read-only tools. Sensible default for a public demo endpoint. |
| `EDGEGAP_APP_ALLOWLIST` | Comma-separated app names the server will touch. |
| `EDGEGAP_MAX_DURATION_MINUTES` | Ceiling on deployment auto-stop. Default 60. |

For a public demo URL, deploy a second Worker with `EDGEGAP_READ_ONLY: "1"`
rather than relaxing the main one.

## 11. Things not to do to this Worker

These are load-bearing, not stylistic:

- **Do not enable observability or request logging.** Request headers on this
  Worker carry customer API tokens. `wrangler.jsonc` ships with
  `observability.enabled: false` for that reason.
- **Do not add KV, D1, or a Durable Object to cache tokens.** The moment
  tokens persist, Edgegap becomes the custodian of every customer's unscopeable
  org-wide credential in one internet-reachable place. That is a different
  company risk profile, not a latency optimisation.
- **Do not add a fallback service token in `vars` or `wrangler secret`.** The
  hosted server having its own ambient Edgegap credential would let any caller
  reach your account without supplying one.
- **Do not relax the path check to strict equality.** Streamable HTTP uses
  subpaths; `pathname === '/mcp'` breaks connections in a way that is painful
  to debug.

## 12. Known gap

The interactive token prompt from the local server does not exist here. On the
2026-07-28 protocol revision the server-to-client request channel was removed,
so `elicitInput` throws on the stateless handler. Hosted users paste a token
into their client config instead.

Closing that gap properly means OAuth
(`@cloudflare/workers-oauth-provider` wired to `createMcpHandler` via
`apiRoute` / `apiHandler`), at which point the token stops transiting this
Worker at all and the header path can be retired.
