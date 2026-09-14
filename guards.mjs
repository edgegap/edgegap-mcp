import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: { PATH: process.env.PATH, EDGEGAP_API_TOKEN: 'fake', EDGEGAP_APP_ALLOWLIST: 'my-game' },
});
const c = new Client({ name: 'guards', version: '1.0.0' });
await c.connect(transport);

const cases = [
  ['deploy with no player locations', 'edgegap_deploy',
    { application: 'my-game', version: 'v1', users: {} }],
  ['memory more than 2x cpu', 'edgegap_create_app_version',
    { application: 'my-game', name: 'v1', docker_repository: 'docker.io',
      docker_image: 'me/srv', docker_tag: 'abc', cpu_units: 512, memory_mb: 4096,
      ports: [{ port: 7777, protocol: 'UDP' }] }],
  ['application outside allowlist', 'edgegap_list_app_versions',
    { application: 'someone-elses-game' }],
];

for (const [label, name, args] of cases) {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content.map(x => x.text).join(' ');
  console.log(`\n[${r.isError ? 'BLOCKED' : 'ALLOWED'}] ${label}`);
  console.log('  ' + text.replace(/\s+/g, ' ').slice(0, 200));
}
await c.close();
