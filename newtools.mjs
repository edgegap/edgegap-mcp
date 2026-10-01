// Exercises the pre-deploy, relay and matchmaker tools against a local mock of
// the Edgegap API (EDGEGAP_BASE_URL), so no real network calls are made.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

// ------------------------------------------------------------- mock API ----
const calls = [];
let provisioned = false;
let relayPolls = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const { pathname } = new URL(req.url, 'http://x');
    const route = `${req.method} ${pathname}`;
    switch (route) {
      case 'GET /v1/wizard/registry-credentials':
        return provisioned
          ? send(200, { registry_url: 'registry.edgegap.com', project: 'my-org-abc123', username: 'robot$my-org', token: 'reg-token-xyz' })
          : send(404, { message: 'no registry project' });
      case 'POST /v1/wizard/init-quick-start':
        provisioned = true;
        return send(204);
      case 'GET /v1/container-registry/images/my-org-abc123/my-game-server/tags':
        return send(200, { data: [{ tag: 'build-42', last_push_at: '2026-09-30T12:00:00Z', artifact: { image_hash: 'sha256:abc', size_mb: 512, artifact_deleted: false, remaining_tags: ['build-42'] } }], total_count: 1 });
      case 'POST /v1/relays/sessions':
        return send(200, { session_id: 'abc123-S', authorization_token: 111, status: 'Initializing', ready: false, linked: false, session_users: [] });
      case 'GET /v1/relays/sessions/abc123-S':
        relayPolls++;
        return send(200, relayPolls < 2
          ? { session_id: 'abc123-S', status: 'Initializing', ready: false, linked: false }
          : { session_id: 'abc123-S', authorization_token: 111, status: 'Linked', ready: true, linked: true,
              session_users: [{ ip_address: '203.0.113.1', authorization_token: 901 }, { ip_address: '198.51.100.7', authorization_token: 902 }],
              relay: { ip: '178.79.131.238', host: 'cc84b011777b.pr.edgegap.net', ports: { server: { port: 31527, protocol: 'UDP', link: 'cc84b011777b.pr.edgegap.net:31527' }, client: { port: 32089, protocol: 'UDP', link: 'cc84b011777b.pr.edgegap.net:32089' } } } });
      case 'POST /v1/relays/sessions:authorize-user':
        return send(200, { session_id: 'abc123-S', authorization_token: 111, status: 'Linked', ready: true, linked: true, session_user: { ip_address: '192.0.2.9', authorization_token: 903 } });
      case 'DELETE /v1/relays/sessions/abc123-S':
        return send(204);
      case 'GET /v1/app/my-game/versions':
        return send(200, { versions: [{ name: 'build-42', is_active: true, ports: [{ port: 7777, protocol: 'UDP', name: 'gameport' }] }, { name: 'no-ports', is_active: true, ports: [] }], total_count: 2 });
      case 'GET /v1/app/ghost-game/versions':
        return send(404, { message: 'App not found' });
      default:
        return send(500, { message: `mock has no route for ${route}` });
    }
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${mock.address().port}`;

async function connect(extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/index.js'],
    env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: 'fake-api-token', EDGEGAP_BASE_URL: base, ...extraEnv },
    stderr: 'ignore',
  });
  const c = new Client({ name: 'newtools', version: '1.0.0' });
  await c.connect(transport);
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');
const json = (r) => JSON.parse(r.content[0].text);

const c = await connect();

// ------------------------------------------------------------ validator ----
console.log('\nvalidate_server_config');
const goodUnity = `FROM ubuntu:22.04
COPY Builds/EdgegapServer /root/build/
RUN chmod +x /root/build/ServerBuild
EXPOSE 7777/udp
CMD ["/bin/bash", "-c", "/root/build/ServerBuild -batchmode -nographics"]`;
let r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: {
  dockerfile: goodUnity, netcode: 'mirror-kcp', ports: [{ port: 7777, protocol: 'UDP' }], cpu_units: 1024, memory_mb: 2048, docker_tag: 'build-42' } }));
check('known-good Unity config passes', r.verdict === 'pass', JSON.stringify([...r.errors, ...r.warnings].map((f) => f.code)));
check('engine detected as unity', r.engine === 'unity');

const badUnreal = `FROM --platform=linux/arm64 ubuntu
COPY . /app
EXPOSE 7777/udp 22
CMD ./StartServer.sh -ip=127.0.0.1`;
r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: {
  dockerfile: badUnreal, ports: [{ port: 7777, protocol: 'TCP' }, { port: 7778, protocol: 'QUIC' }], docker_tag: 'latest', cpu_units: 512, memory_mb: 4096 } }));
const codes = [...r.errors, ...r.warnings].map((f) => f.code);
check('bad Unreal config fails', r.verdict === 'fail');
for (const code of ['wrong-platform', 'unreal-root', 'crlf-script', 'loopback-bind', 'ssh-exposed', 'unpinned-base', 'protocol-mismatch', 'bad-protocol', 'latest-tag', 'memory-ratio']) {
  check(`flags ${code}`, codes.includes(code), codes.join(','));
}
check('returns reference Unreal Dockerfile on failure', /USER server/.test(r.reference_dockerfile ?? ''));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { netcode: 'mirror-kcp', ports: [{ port: 7777, protocol: 'TCP' }] } }));
check('netcode/protocol mismatch is an error', r.errors.some((f) => f.code === 'netcode-protocol'));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { engine: 'unity' } }));
check('no Dockerfile + engine returns the reference template', /-batchmode -nographics/.test(r.reference_dockerfile ?? ''));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: { docker_repository: 'registry.edgegap.com', docker_image: 'my-game-server', docker_tag: 'b1' } }));
check('registry.edgegap.com image without project is an error', r.errors.some((f) => f.code === 'missing-project'));

r = json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: {
  dockerfile: 'FROM ubuntu:22.04\nCOPY build/Server.exe /app/\nCMD ["/app/Server.exe"]' } }));
check('Windows .exe build is an error', r.errors.some((f) => f.code === 'windows-binary'));

// ------------------------------------------------------ generate_dockerfile ----
console.log('\ngenerate_dockerfile');
const gen = async (args) => c.callTool({ name: 'edgegap_generate_dockerfile', arguments: args });
const validate = async (args) => json(await c.callTool({ name: 'edgegap_validate_server_config', arguments: args }));

// The core guarantee: whatever the generator writes, the validator accepts.
const genCases = [
  ['unity defaults', { engine: 'unity' }],
  ['unreal defaults', { engine: 'unreal' }],
  ['godot defaults', { engine: 'godot' }],
  ['unity custom build', { engine: 'unity', build_path: 'Build/Linux', executable: 'MyGame.x86_64', ports: [{ port: 7770, protocol: 'UDP' }], netcode: 'fishnet-tugboat', launch_args: ['-logfile', '/dev/stdout'] }],
  ['unreal packaged binary script', { engine: 'unreal', executable: 'MyGameServer.sh', launch_args: ['-log', '-port=7777'] }],
  ['other engine, TCP/UDP + WS ports', { engine: 'other', executable: 'server', ports: [{ port: 9000, protocol: 'TCP/UDP' }, { port: 9001, protocol: 'WS', name: 'web' }] }],
];
for (const [label, args] of genCases) {
  const res = await gen(args);
  if (res.isError) { check(`${label}: generated`, false, text(res)); continue; }
  const g = json(res);
  const v = await validate({ dockerfile: g.dockerfile, engine: args.engine, netcode: args.netcode, ports: g.ports_for_create_app_version });
  check(`${label}: passes the validator with no errors or warnings`, v.verdict === 'pass', JSON.stringify([...v.errors, ...v.warnings].map((f) => f.code)));
}

let g = json(await gen({ engine: 'unity', build_path: 'Build/Linux', executable: 'MyGame.x86_64', ports: [{ port: 7770, protocol: 'UDP' }], launch_args: ['-logfile', '/dev/stdout'] }));
check('unity: copies the given build folder', g.dockerfile.includes('COPY Build/Linux /root/build/'));
check('unity: launches the given binary headless with the extra args', g.dockerfile.includes('/root/build/MyGame.x86_64 -batchmode -nographics -logfile /dev/stdout'));
check('unity: does not dump env vars into logs', !g.dockerfile.includes('env;'));
check('unity: EXPOSE matches the port', g.dockerfile.includes('EXPOSE 7770/udp'));
check('nothing assumed when everything is given', !g.assumptions.some((a) => /Assumed/.test(a)), JSON.stringify(g.assumptions));
check('returns ports for create_app_version', JSON.stringify(g.ports_for_create_app_version) === JSON.stringify([{ port: 7770, protocol: 'UDP', name: 'gameport' }]));
check('local test command maps the UDP port', g.commands.test_locally.includes('-p 7770:7770/udp'));

g = json(await gen({ engine: 'unity' }));
check('defaults are listed as assumptions to confirm', g.assumptions.some((a) => /ServerBuild/.test(a)) && g.assumptions.some((a) => /7777/.test(a)));
g = json(await gen({ engine: 'unity', netcode: 'mirror-telepathy' }));
check('netcode picks the protocol (Telepathy -> TCP)', g.ports_for_create_app_version[0].protocol === 'TCP' && g.dockerfile.includes('EXPOSE 7777/tcp'));
g = json(await gen({ engine: 'unreal' }));
check('unreal: non-root user and CRLF fix', g.dockerfile.includes('USER server') && g.dockerfile.includes("sed -i 's/\\r$//' /app/StartServer.sh"));
g = json(await gen({ engine: 'godot', executable: 'game.x86_64' }));
check('godot: --headless in exec form', g.dockerfile.includes('CMD ["/app/game.x86_64","--headless"]'));
g = json(await gen({ engine: 'other', executable: 'srv', ports: [{ port: 9000, protocol: 'TCP/UDP' }] }));
check('TCP/UDP exposes both', g.dockerfile.includes('EXPOSE 9000/udp') && g.dockerfile.includes('EXPOSE 9000/tcp'));

let gr = await gen({ engine: 'other' });
check('other engine requires executable', gr.isError && /executable is required/.test(text(gr)));
gr = await gen({ engine: 'unity', launch_args: ['-port 7777; rm -rf /'] });
check('rejects shell metacharacters in launch args', gr.isError === true);
gr = await gen({ engine: 'unity', build_path: '../secrets' });
check('rejects build paths outside the build context', gr.isError === true);
gr = await gen({ engine: 'unity', executable: 'Server"\nRUN curl evil' });
check('rejects executable names that would inject Dockerfile lines', gr.isError === true);

// ---------------------------------------------------- server vs relay guidance ----
console.log('\nserver vs relay guidance');
const instructions = c.getInstructions() ?? '';
check('instructions recommend a dedicated server by default', /recommend a dedicated server by default/i.test(instructions));
check('instructions say a relay is not a game server', /Relay .*NOT a game server/s.test(instructions));
check('instructions start the golden path with generate_dockerfile', instructions.includes('1. edgegap_generate_dockerfile'));
const listed = (await c.listTools()).tools;
const desc = (n) => listed.find((t) => t.name === n)?.description ?? '';
check('relay tool leads with "NOT a game server"', /^A relay is NOT a game server/.test(desc('edgegap_create_relay_session')));
check('relay tool points to edgegap_deploy instead', /edgegap_deploy/.test(desc('edgegap_create_relay_session')));
check('deploy tool says it is the recommended authoritative server', /authoritative dedicated game server/.test(desc('edgegap_deploy')) && /recommended/.test(desc('edgegap_deploy')));

// ------------------------------------------------------------- registry ----
console.log('\nregistry');
calls.length = 0;
let res = await c.callTool({ name: 'edgegap_get_registry_credentials', arguments: { image_name: 'my-game-server', tag: 'build-42' } });
r = json(res);
check('provisions via init-quick-start when credentials 404', calls.some((x) => x.url === '/v1/wizard/init-quick-start' && x.body?.source === 'mcp'));
check('returns project/username/token', r.project === 'my-org-abc123' && r.username === 'robot$my-org' && r.token === 'reg-token-xyz');
check('image ref includes project and tag', r.image_ref === 'registry.edgegap.com/my-org-abc123/my-game-server:build-42');
check('login uses --password-stdin, token not on the command line', /--password-stdin/.test(r.commands.login) && !r.commands.login.includes('reg-token-xyz'));
check('build targets linux/amd64', /--platform linux\/amd64/.test(r.commands.build));
check('API token sent as "token <value>"', calls.every((x) => x.auth === 'token fake-api-token'));
check('API token never in output', !text(res).includes('fake-api-token'));
res = await c.callTool({ name: 'edgegap_get_registry_credentials', arguments: { tag: 'latest' } });
check('rejects the "latest" tag', res.isError === true);

r = json(await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'my-org-abc123/my-game-server' } }));
check('lists pushed tags (slash kept in path)', r.tags?.[0]?.tag === 'build-42' && r.tags[0].size_mb === 512);
res = await c.callTool({ name: 'edgegap_list_registry_tags', arguments: { image_name: 'my-game-server' } });
check('tag listing without project prefix is refused locally', res.isError === true);

// --------------------------------------------------------------- relays ----
console.log('\nrelays');
calls.length = 0;
res = await c.callTool({ name: 'edgegap_create_relay_session', arguments: { user_ips: ['203.0.113.1', '198.51.100.7'] } });
r = json(res);
const createCall = calls.find((x) => x.method === 'POST' && x.url === '/v1/relays/sessions');
check('sends users as [{ip}]', JSON.stringify(createCall?.body) === JSON.stringify({ users: [{ ip: '203.0.113.1' }, { ip: '198.51.100.7' }] }), JSON.stringify(createCall?.body));
check('waits until ready', r.ready === true && relayPolls >= 2, `ready=${r.ready} polls=${relayPolls}`);
check('returns relay host and both ports', r.relay?.host === 'cc84b011777b.pr.edgegap.net' && r.relay.server_port?.port === 31527 && r.relay.client_port?.port === 32089);
check('returns per-player authorization tokens', r.users?.length === 2 && r.users[0].authorization_token === 901);
check('returns session authorization token', r.session_authorization_token === 111);
check('relay result says it is not a game server and recommends one', /relay, not a game server/.test(r.architecture_note ?? '') && /recommend a dedicated server/.test(r.architecture_note ?? ''));

r = json(await c.callTool({ name: 'edgegap_authorize_relay_user', arguments: { session_id: 'abc123-S', user_ip: '192.0.2.9' } }));
check('authorize returns the new player token', r.user_authorization_token === 903);
r = json(await c.callTool({ name: 'edgegap_get_relay_session', arguments: { session_id: 'abc123-S' } }));
check('get returns the session', r.session_id === 'abc123-S' && r.ready === true);
res = await c.callTool({ name: 'edgegap_delete_relay_session', arguments: { session_id: 'abc123-S' } });
check('delete succeeds on 204', !res.isError && calls.some((x) => x.method === 'DELETE' && x.url === '/v1/relays/sessions/abc123-S'));

// ----------------------------------------------------------- matchmaker ----
console.log('\nmatchmaker');
const mm = { profile_name: 'casual-2v2', application: 'my-game', version: 'build-42', team_count: 2, min_team_size: 2, max_team_size: 2 };
r = json(await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, max_latency_ms: 150, expansions: [{ after_seconds: 30, max_latency_ms: 250 }] } }));
const prof = r.config?.profiles?.['casual-2v2'];
check('builds a profile pointing at the version', prof?.application?.name === 'my-game' && prof.application.version === 'build-42');
check('player_count rule', prof?.rules.initial.match_size.type === 'player_count' && prof.rules.initial.match_size.attributes.team_count === 2);
check('latency rule and expansion', prof?.rules.initial.beacons.attributes.max_latency === 150 && prof.rules.expansions['30'].beacons.max_latency === 250);
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, version: 'nope' } });
check('missing version is reported', res.isError && /not found/.test(text(res)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, version: 'no-ports' } });
check('version without ports is reported', res.isError && /no ports/.test(text(res)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, application: 'ghost-game' } });
check('missing application is reported', res.isError && /does not exist/.test(text(res)));
res = await c.callTool({ name: 'edgegap_build_matchmaker_config', arguments: { ...mm, min_team_size: 3, verify_version: false } });
check('min > max team size is reported', res.isError && /greater than max_team_size/.test(text(res)));
await c.close();

// ------------------------------------------------------------ read-only ----
console.log('\nread-only mode');
const ro = await connect({ EDGEGAP_READ_ONLY: '1' });
const names = (await ro.listTools()).tools.map((t) => t.name);
for (const n of ['edgegap_get_registry_credentials', 'edgegap_create_relay_session', 'edgegap_authorize_relay_user', 'edgegap_delete_relay_session']) {
  check(`${n} hidden`, !names.includes(n));
}
for (const n of ['edgegap_generate_dockerfile', 'edgegap_validate_server_config', 'edgegap_list_registry_tags', 'edgegap_get_relay_session', 'edgegap_build_matchmaker_config']) {
  check(`${n} available`, names.includes(n));
}
await ro.close();

// ------------------------------------------------------------ allowlist ----
const al = await connect({ EDGEGAP_APP_ALLOWLIST: 'other-game' });
res = await al.callTool({ name: 'edgegap_build_matchmaker_config', arguments: mm });
check('matchmaker builder respects EDGEGAP_APP_ALLOWLIST', res.isError && /ALLOWLIST/.test(text(res)));
await al.close();

mock.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
