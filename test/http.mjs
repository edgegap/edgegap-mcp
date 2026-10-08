// Exercises the self-hosted HTTP server (dist/http.js) against a local mock of
// the Edgegap API (EDGEGAP_BASE_URL), so no real network calls are made.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const TOKEN = '0f8b3c1e-e458-4592-b607-c2c28afd8b62';
const calls = [];
const mock = http.createServer((req, res) => {
  calls.push({ url: req.url, auth: req.headers.authorization });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ applications: [{ name: 'my-game' }], total_count: 1 }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));

const port = 18000 + Math.floor(Math.random() * 1000);
// Started through the main command's --http flag, the way npm users run it.
const proc = spawn('node', ['dist/index.js', '--http'], {
  env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1',
    EDGEGAP_BASE_URL: `http://127.0.0.1:${mock.address().port}`,
    EDGEGAP_API_TOKEN: 'ambient-token-must-be-ignored' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
await new Promise((resolve, reject) => {
  proc.stderr.on('data', (d) => /listening/.test(d) && resolve());
  proc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
});
const base = `http://127.0.0.1:${port}`;

async function connect(authorization) {
  const c = new Client({ name: 'http-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: authorization ? { headers: { Authorization: authorization } } : undefined,
  }));
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');

console.log('\nhttp server');
check('/health answers without a token', (await (await fetch(`${base}/health`)).text()) === 'ok');
check('GET /mcp is refused (stateless)', (await fetch(`${base}/mcp`)).status === 405);
check('unknown path is 404', (await fetch(`${base}/nope`)).status === 404);

let c = await connect();
const { tools } = await c.listTools();
check('discovery works without a token', tools.length >= 19, `${tools.length} tools`);
let r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('tool call without a token explains what to do', r.isError && /No Edgegap API token/.test(text(r)));
check('ambient EDGEGAP_API_TOKEN is never used', !calls.some((x) => /ambient/.test(x.auth ?? '')));
await c.close();

c = await connect('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig');
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('a foreign JWT is not relayed', r.isError && /does not contain an Edgegap/.test(text(r)) && calls.length === 0);
await c.close();

c = await connect(`token ${TOKEN}`);
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
check('a real token reaches the API as "token <value>"', !r.isError && calls.at(-1)?.auth === `token ${TOKEN}`, text(r).slice(0, 200));
check('the token never appears in output', !text(r).includes(TOKEN));
await c.close();

proc.kill('SIGTERM');
mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
