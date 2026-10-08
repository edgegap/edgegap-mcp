// Packaging checks: the things that broke installs without breaking any tool.
//
// 0.3.0 shipped two `bin` commands, neither named `mcp`, so `npx -y
// @edgegap/mcp` (the config in the README and every client that copied it)
// failed with "could not determine executable to run". No tool test caught it
// because they all run dist/index.js directly.
import { readFileSync } from 'node:fs';

let failures = 0;
function check(label, cond, detail = '') {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));

console.log('\npackage');

// npm's rule (get-bin-from-manifest): run the only command; otherwise the one
// named like the package minus its scope; otherwise fail.
const bins = typeof pkg.bin === 'string' ? [pkg.name.split('/').pop()] : Object.keys(pkg.bin ?? {});
const unscoped = pkg.name.split('/').pop();
check(
  `npx ${pkg.name} resolves to a command`,
  bins.length === 1 || bins.includes(unscoped),
  `bin has ${bins.length} commands (${bins.join(', ')}) and none is named "${unscoped}"`
);
check('the command runs the stdio server', pkg.bin?.['edgegap-mcp'] === 'dist/index.js', JSON.stringify(pkg.bin));

// Everything in dependencies is installed by every `npx @edgegap/mcp`. The
// Cloudflare Worker's packages pulled in Babel 8, whose engines (^22.18 ||
// >=24.11) printed a dozen EBADENGINE warnings on Node 22.15.
for (const workerOnly of ['agents', '@modelcontextprotocol/server', 'wrangler']) {
  check(`${workerOnly} is not a runtime dependency`, !(workerOnly in (pkg.dependencies ?? {})));
}
check('repository field set, so npm links to the source', /github\.com\/edgegap\/edgegap-mcp/.test(pkg.repository?.url ?? ''));
check('mcpName matches the registry name', pkg.mcpName === server.name, `${pkg.mcpName} vs ${server.name}`);

// The version is hardcoded in five places; a release with them out of step
// tells clients one version and npm another.
const v = pkg.version;
check(`server.json version is ${v}`, server.version === v, server.version);
check(`server.json npm package version is ${v}`, server.packages?.[0]?.version === v, server.packages?.[0]?.version);
for (const file of ['src/index.ts', 'src/http.ts', 'worker/worker.ts']) {
  const found = readFileSync(file, 'utf8').match(/name: 'edgegap', version: '([^']+)'/)?.[1];
  check(`${file} reports ${v}`, found === v, found ?? 'no version string found');
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
