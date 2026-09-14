import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function run(label, env) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { PATH: process.env.PATH, ...env },
  });
  const client = new Client({ name: 'smoke', version: '1.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`\n--- ${label}: ${tools.length} tools ---`);
  for (const t of tools) {
    const req = t.inputSchema?.required ?? [];
    console.log(`  ${t.name.padEnd(30)} required=[${req.join(',')}]`);
  }
  await client.close();
  return tools;
}

const full = await run('default', { EDGEGAP_API_TOKEN: 'fake-token-for-smoke-test' });
await run('read-only', { EDGEGAP_API_TOKEN: 'fake-token-for-smoke-test', EDGEGAP_READ_ONLY: '1' });

// Every tool must carry a description an agent can route on.
const thin = full.filter((t) => !t.description || t.description.length < 80);
console.log('\nTools with thin descriptions:', thin.length === 0 ? 'none' : thin.map(t=>t.name));
