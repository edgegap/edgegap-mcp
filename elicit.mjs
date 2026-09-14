import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

async function connect(respond, caps = { elicitation: {} }) {
  const transport = new StdioClientTransport({
    command: 'node', args: ['dist/index.js'],
    env: { PATH: process.env.PATH },   // deliberately NO token in env
  });
  const c = new Client({ name: 'test', version: '1.0.0' }, { capabilities: caps });
  if (respond) c.setRequestHandler(ElicitRequestSchema, respond);
  await c.connect(transport);
  return c;
}

let captured = null;

// 1. Developer accepts and acknowledges.
let c = await connect(async (req) => {
  captured = req.params;
  return { action: 'accept', content: { api_token: 'super-secret-abc123', acknowledged: true } };
});
let r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
const text1 = r.content.map(x => x.text).join('\n');
console.log('1. ACCEPTED — prompt was shown:', captured !== null);
console.log('   warning mentions org-wide scope:', /entire Edgegap organization/.test(captured.message));
console.log('   acknowledgement is required   :', captured.requestedSchema.required.includes('acknowledged'));
console.log('   token leaked into output      :', text1.includes('super-secret-abc123'));
console.log('   first-use reminder attached   :', /revoke it at/i.test(text1));
await c.close();

// 2. Developer refuses the acknowledgement checkbox.
c = await connect(async () => ({ action: 'accept', content: { api_token: 'abc', acknowledged: false } }));
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
console.log('\n2. NOT ACKNOWLEDGED — blocked:', r.isError === true);
console.log('   ' + r.content[0].text.replace(/\s+/g, ' ').slice(0, 130));
await c.close();

// 3. Developer declines outright.
c = await connect(async () => ({ action: 'decline' }));
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
console.log('\n3. DECLINED — blocked:', r.isError === true);
console.log('   ' + r.content[0].text.replace(/\s+/g, ' ').slice(0, 130));
await c.close();

// 4. Client that cannot prompt at all.
c = await connect(null, {});
r = await c.callTool({ name: 'edgegap_list_apps', arguments: {} });
console.log('\n4. NO ELICITATION SUPPORT — falls back to env var instructions:', r.isError === true);
console.log('   ' + r.content[0].text.replace(/\s+/g, ' ').slice(0, 130));
await c.close();
