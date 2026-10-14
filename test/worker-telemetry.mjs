// End-to-end check of the hosted Worker's PostHog analytics: runs the real
// Worker under `wrangler dev` with POSTHOG_HOST pointed at a local fake
// PostHog, makes MCP calls, and inspects every payload the Worker sends.
//
//   npm run test:worker      (needs wrangler; not part of `npm test`)
//
// No call reaches Edgegap: the only API-bound call uses dry_run.
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
const SECRET_IP = '203.0.113.77';
const SECRET_ENV = 'env-value-must-not-leak';

// ------------------------------------------------------- fake PostHog ----
const events = [];
const posthog = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    events.push({ path: req.url, raw: body, json: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"Ok"}');
  });
});
await new Promise((r) => posthog.listen(0, '127.0.0.1', r));

// ------------------------------------------------------------ Worker ----
const port = 8700 + Math.floor(Math.random() * 90);
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const worker = spawn(npx, [
  'wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--local', '--port', String(port),
  '--var', 'POSTHOG_API_KEY:phc_test_key',
  '--var', `POSTHOG_HOST:http://127.0.0.1:${posthog.address().port}`,
  '--var', 'TELEMETRY_SALT:test-salt',
], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 90; i++) {
  try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}

let id = 0;
async function rpc(method, params, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'User-Agent': 'telemetry-test/1.0', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  return res.text();
}
const settle = () => new Promise((r) => setTimeout(r, 1500));
const byEvent = (name) => events.filter((e) => e.json.event === name);

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } });
  await rpc('tools/call', { name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity' } });
  await rpc('prompts/get', { name: 'edgegap-unreal' });
  await rpc('resources/read', { uri: 'edgegap-skill://edgegap/SKILL.md' });
  await rpc('tools/call', { name: 'edgegap_stop_deployment', arguments: { request_id: '*' } });
  const auth = { Authorization: `token ${TOKEN}` };
  await rpc('tools/call', { name: 'edgegap_deploy', arguments: { application: 'secret-app-name', version: 'v1', users: { ip_addresses: [SECRET_IP] }, env: [{ key: 'K', value: SECRET_ENV }], dry_run: true } }, auth);
  await rpc('tools/call', { name: 'edgegap_context', arguments: {} }, auth);
  await settle();

  console.log('\nevents');
  const init = byEvent('mcp_initialize')[0]?.json;
  check('initialize: client name and version', init?.properties.client_name === 'claude-code' && init.properties.client_version === '2.1.0');
  const skill = byEvent('mcp_tool_call').find((e) => e.json.properties.tool === 'edgegap_get_skill')?.json;
  check('get_skill: tool, success and skill name', skill?.properties.success === true && skill.properties.skill === 'edgegap-unity');
  check('prompt read: skill name', byEvent('mcp_prompt_get')[0]?.json.properties.prompt === 'edgegap-unreal');
  check('resource read: skill URI', byEvent('mcp_resource_read')[0]?.json.properties.resource === 'edgegap-skill://edgegap/SKILL.md');
  const refused = byEvent('mcp_tool_call').find((e) => e.json.properties.tool === 'edgegap_stop_deployment')?.json;
  check('a refused stop: success false, error_kind refused', refused?.properties.success === false && refused.properties.error_kind === 'refused');
  const deploy = byEvent('mcp_tool_call').find((e) => e.json.properties.tool === 'edgegap_deploy')?.json;
  check('deploy dry run: dry_run true, duration recorded', deploy?.properties.dry_run === true && typeof deploy.properties.duration_ms === 'number');
  check('posted to /i/v0/e/ with the project key', events.every((e) => e.path === '/i/v0/e/' && e.json.api_key === 'phc_test_key'));

  console.log('\nidentity');
  const withToken = events.filter((e) => e.json.properties.has_token === true);
  const anon = events.filter((e) => e.json.properties.has_token === false);
  check('token requests: hashed org_ id, the same for both calls', withToken.length >= 2 && withToken.every((e) => /^org_[0-9a-f]{32}$/.test(e.json.distinct_id)) && new Set(withToken.map((e) => e.json.distinct_id)).size === 1);
  check('no-token requests: anonymous, no person profile', anon.length > 0 && anon.every((e) => e.json.distinct_id.startsWith('anon_') && e.json.properties.$process_person_profile === false));

  console.log('\nprivacy');
  const everything = events.map((e) => e.raw).join('\n');
  check('the API token is never sent', !everything.includes(TOKEN) && !everything.includes(TOKEN.replace(/-/g, '')));
  check('tool arguments are never sent (IP, env value, app name)', !everything.includes(SECRET_IP) && !everything.includes(SECRET_ENV) && !everything.includes('secret-app-name'));
  check('GeoIP disabled on every event', events.every((e) => e.json.properties.$geoip_disable === true));

  console.log('\nopt-out');
  const before = events.length;
  await rpc('tools/call', { name: 'edgegap_list_skills', arguments: {} }, { 'X-Edgegap-Telemetry': 'off' });
  await rpc('tools/call', { name: 'edgegap_list_skills', arguments: {} }, { DNT: '1' });
  await settle();
  check('X-Edgegap-Telemetry: off and DNT: 1 send nothing', events.length === before, `${events.length - before} events`);
} finally {
  // wrangler starts workerd as a child: kill the whole tree, and wait for it.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(worker.pid), '/T', '/F'], { stdio: 'ignore' });
  else worker.kill('SIGINT');
  posthog.close();
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
