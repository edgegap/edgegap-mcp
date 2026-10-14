// The Edgegap agent skills served over MCP: tools, prompts and resources, all
// from the bundle in src/skills.generated.ts. No network, no token needed.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SKILLS_PACK } from '../dist/skills.generated.js';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

async function connect(env = {}) {
  const c = new Client({ name: 'skills-test', version: '1.0.0' });
  // No EDGEGAP_API_TOKEN: skills must work before any token exists.
  await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/index.js'], stderr: 'ignore', env: { PATH: process.env.PATH, ...env } }));
  return c;
}
const body = (r) => r.content.filter((x, i) => !(i === 0 && /^\[[^\]]+\]$/.test(x.text))).map((x) => x.text).join('\n');
const totalFiles = SKILLS_PACK.skills.reduce((n, s) => n + s.files.length, 0);

console.log('\nbundle');
const pin = readFileSync('scripts/skills-pin.txt', 'utf8').trim();
check('bundle is the pinned commit', SKILLS_PACK.commit === pin, `${SKILLS_PACK.commit} vs ${pin}`);
check('bundle has the core skills', ['edgegap', 'edgegap-unity', 'edgegap-unreal'].every((n) => SKILLS_PACK.skills.some((s) => s.name === n)));
check('every skill starts with its SKILL.md', SKILLS_PACK.skills.every((s) => s.files[0].path === 'SKILL.md' && s.files[0].content.includes(`name: ${s.name}`)));
check('no evals, scripts or fixtures bundled', SKILLS_PACK.skills.every((s) => s.files.every((f) => !/^(evals|scripts|fixtures)\//.test(f.path))));
check('no Windows line endings', SKILLS_PACK.skills.every((s) => s.files.every((f) => !f.content.includes('\r\n'))));

const c = await connect();

console.log('\ntools');
let r = await c.callTool({ name: 'edgegap_list_skills', arguments: {} });
const listed = JSON.parse(body(r));
check('edgegap_list_skills works with no token', !r.isError && listed.skills.length === SKILLS_PACK.skills.length);
check('lists names, versions and descriptions', listed.skills.every((s) => s.name && s.version && s.description.length > 40));
check('names the pack version and commit', listed.pack === `${SKILLS_PACK.version} (${SKILLS_PACK.commit.slice(0, 7)})`);

r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity' } });
let t = body(r);
const unity = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unity');
check('get_skill returns SKILL.md by default', !r.isError && t.includes(unity.files[0].content));
check('and lists the other files with how to fetch them', t.includes('references/deploy.md') && t.includes('edgegap_get_skill {skill: "edgegap-unity"'));

const ref = unity.files.find((f) => f.path.startsWith('references/'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: ref.path } });
check(`get_skill returns ${ref.path}`, !r.isError && body(r).includes(ref.content));
const asset = unity.files.find((f) => f.path.endsWith('.cs'));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: asset.path } });
check(`get_skill returns a template (${asset.path}) exactly`, !r.isError && body(r).endsWith(asset.content));
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: `./${ref.path}` } });
check('a leading ./ is accepted', !r.isError);

for (const bad of ['../edgegap/SKILL.md', '/etc/passwd', 'C:\\Windows\\win.ini', 'references/../../package.json', 'missing.md']) {
  r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'edgegap-unity', file: bad } });
  check(`file "${bad}" is not found, and the real files are listed`, r.isError && /is not a file in the edgegap-unity skill/.test(body(r)) && body(r).includes('- SKILL.md'));
}
r = await c.callTool({ name: 'edgegap_get_skill', arguments: { skill: 'not-a-skill' } }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
check('an unknown skill is rejected', r.isError === true);

console.log('\nprompts');
const { prompts } = await c.listPrompts();
check('one prompt per skill', SKILLS_PACK.skills.every((s) => prompts.some((p) => p.name === s.name)), prompts.map((p) => p.name).join(', '));
const p = await c.getPrompt({ name: 'edgegap-unreal' });
const unreal = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unreal');
check('a prompt carries the whole SKILL.md as a user message', p.messages[0].role === 'user' && p.messages[0].content.text.includes(unreal.files[0].content));

console.log('\nresources');
const all = [];
let cursor;
do {
  const page = await c.listResources(cursor ? { cursor } : undefined);
  all.push(...page.resources);
  cursor = page.nextCursor;
} while (cursor);
const skillRes = all.filter((x) => x.uri.startsWith('edgegap-skill://'));
check('one resource per bundled file', skillRes.length === totalFiles, `${skillRes.length} vs ${totalFiles}`);
const dockerfile = SKILLS_PACK.skills.find((s) => s.name === 'edgegap-unreal').files.find((f) => f.path === 'assets/docker/Dockerfile');
const read = await c.readResource({ uri: 'edgegap-skill://edgegap-unreal/assets/docker/Dockerfile' });
check('reading a resource returns the file', read.contents[0].text === dockerfile.content);
check('markdown resources are typed text/markdown', skillRes.find((x) => x.uri === 'edgegap-skill://edgegap/SKILL.md')?.mimeType === 'text/markdown');
const ctx = JSON.parse(body(await c.callTool({ name: 'edgegap_context', arguments: {} })));
check('edgegap_context reports the skills pack', ctx.skills_pack?.startsWith(SKILLS_PACK.version));
check('server instructions point at the skills', /edgegap_get_skill/.test(c.getInstructions() ?? ''));
await c.close();

console.log('\nread-only mode');
const ro = await connect({ EDGEGAP_READ_ONLY: '1' });
const names = (await ro.listTools()).tools.map((x) => x.name);
check('skills tools are available in read-only mode', names.includes('edgegap_list_skills') && names.includes('edgegap_get_skill'));
await ro.close();

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
