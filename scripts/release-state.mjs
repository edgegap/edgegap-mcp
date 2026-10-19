// Where the version in package.json is live: npm, the MCP registry, the hosted
// server at mcp.edgegap.dev, and the git tag. The release workflow runs each
// step only where the version is missing, so re-running it after a failure
// picks up where it stopped.
//
//   node scripts/release-state.mjs           print the state, exit 1 unless live everywhere
//   node scripts/release-state.mjs --github  also write it to $GITHUB_OUTPUT
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
const v = pkg.version;
const HOSTED = process.env.HOSTED_URL ?? 'https://mcp.edgegap.dev/mcp';

async function npm() {
  const r = await fetch(`https://registry.npmjs.org/${pkg.name}/${v}`);
  return r.ok;
}

async function registry() {
  const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(server.name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`MCP registry answered ${r.status}`);
  const { servers = [] } = await r.json();
  return servers.some((s) => s.server?.name === server.name && s.server?.version === v);
}

async function hosted() {
  const r = await fetch(HOSTED, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-state', version: v } },
    }),
  });
  const text = await r.text();
  const found = text.match(/"serverInfo":\{"name":"edgegap","version":"([^"]+)"/)?.[1];
  return { live: found === v, found: found ?? `no serverInfo (HTTP ${r.status})` };
}

function tag() {
  try {
    return execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${v}`], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}

const h = await hosted();
const state = { version: v, npm: await npm(), registry: await registry(), hosted: h.live, tag: tag() };

console.log(`@edgegap/mcp ${v}`);
console.log(`  npm       ${state.npm ? 'live' : 'missing'}`);
console.log(`  registry  ${state.registry ? 'live' : 'missing'}`);
console.log(`  hosted    ${state.hosted ? 'live' : `missing (serves ${h.found})`}`);
console.log(`  tag       ${state.tag ? `v${v}` : 'missing'}`);

if (process.argv.includes('--github')) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(state).map(([k, x]) => `${k}=${x}\n`).join(''));
} else {
  process.exit(state.npm && state.registry && state.hosted && state.tag ? 0 : 1);
}
