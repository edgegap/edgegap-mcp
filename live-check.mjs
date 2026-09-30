// Live check of the 0.2.0 tools against the REAL Edgegap API.
// Use a token from a non-production organization.
//
//   EDGEGAP_API_TOKEN=...   required
//   LIVE_IP=203.0.113.1     your public IP; enables the relay checks (creates and deletes one session)
//   LIVE_APP / LIVE_VERSION an existing app version; enables the matchmaker version check
//
// Prints what the API actually returned for each assumption the mock tests could not prove.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const token = process.env.EDGEGAP_API_TOKEN;
if (!token) { console.error('Set EDGEGAP_API_TOKEN.'); process.exit(1); }

const c = new Client({ name: 'live-check', version: '1.0.0' });
await c.connect(new StdioClientTransport({
  command: 'node', args: ['dist/index.js'], stderr: 'ignore',
  env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: token },
}));

let registryToken;
const mask = (s) => [token, registryToken].filter(Boolean).reduce((t, v) => t.split(v).join('<redacted>'), s);
async function call(label, name, args) {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.map((x) => x.text).join('\n');
  console.log(`\n=== ${label} [${r.isError ? 'ERROR' : 'ok'}]\n${mask(text).slice(0, 1500)}`);
  return { r, text };
}

const { tools } = await c.listTools();
console.log(`tools registered: ${tools.length} (expect 18)`);

// Assumption 1+2: wizard endpoint works for this org, and init-quick-start accepts source "mcp".
const creds = await call('registry credentials (wizard endpoint, init-quick-start source "mcp")',
  'edgegap_get_registry_credentials', { image_name: 'mcp-live-check', tag: 'check-1' });
let project;
if (!creds.r.isError) {
  const data = JSON.parse(creds.r.content[0].text);
  registryToken = data.token;
  project = data.project;
}

// Assumption 3: tag listing accepts "<project>/<image>" with the slash unencoded.
// For an image that was never pushed, a 404 about the image is fine; a 404 about the route is not.
if (project) {
  await call('registry tag listing path format', 'edgegap_list_registry_tags', { image_name: `${project}/mcp-live-check` });
}

// Assumption 4: relay body shape [{ip}] and the response fields we surface.
if (process.env.LIVE_IP) {
  const created = await call('relay create + wait', 'edgegap_create_relay_session', { user_ips: [process.env.LIVE_IP] });
  const id = created.text.match(/"session_id":\s*"([^"]+)"/)?.[1] ?? created.text.match(/session ([\w-]+-S)/)?.[1];
  if (id) {
    await call('relay get', 'edgegap_get_relay_session', { session_id: id });
    await call('relay delete (cleanup)', 'edgegap_delete_relay_session', { session_id: id });
  } else {
    console.log('\n!!! Could not read a session_id. Check the dashboard for a leftover relay session and delete it.');
  }
} else {
  console.log('\n(skipped relay checks: set LIVE_IP)');
}

if (process.env.LIVE_APP && process.env.LIVE_VERSION) {
  await call('matchmaker config + version lookup', 'edgegap_build_matchmaker_config', {
    profile_name: 'live-check', application: process.env.LIVE_APP, version: process.env.LIVE_VERSION,
    team_count: 1, min_team_size: 2, max_team_size: 2 });
} else {
  console.log('\n(skipped matchmaker check: set LIVE_APP and LIVE_VERSION)');
}

await c.close();
