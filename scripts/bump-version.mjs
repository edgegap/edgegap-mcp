// Set the release version everywhere it is hardcoded (test/package.mjs fails
// if they drift): package.json, package-lock.json, server.json (twice),
// src/version.ts and the pinned install line in README.md.
//
//   node scripts/bump-version.mjs patch|minor|major|<x.y.z>
import { readFileSync, writeFileSync } from 'node:fs';

const arg = process.argv[2];
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const old = pkg.version;
const [maj, min, pat] = old.split('.').map(Number);
const next = { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` }[arg] ?? arg;
if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) {
  console.error('Usage: node scripts/bump-version.mjs patch|minor|major|<x.y.z>');
  process.exit(1);
}

function edit(file, fn) {
  const before = readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`${file}: version ${old} not found`);
  writeFileSync(file, after);
}

const json = (file, fn) => edit(file, (s) => {
  const d = JSON.parse(s);
  fn(d);
  return JSON.stringify(d, null, 2) + '\n';
});

json('package.json', (d) => { d.version = next; });
json('package-lock.json', (d) => { d.version = next; d.packages[''].version = next; });
edit('server.json', (s) => s.replaceAll(`"version": "${old}"`, `"version": "${next}"`));
edit('src/version.ts', (s) => s.replace(`VERSION = '${old}'`, `VERSION = '${next}'`));
edit('README.md', (s) => s.replaceAll(`@edgegap/mcp@${old}`, `@edgegap/mcp@${next}`));

console.log(`${old} -> ${next}`);
