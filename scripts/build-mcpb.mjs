// Builds edgegap-mcp.mcpb, the one-click install bundle for Claude Desktop and
// other MCPB clients: manifest.json, icon.png, dist/ and the runtime
// dependencies only (no Worker or test packages).
//
//   npm run build && node scripts/build-mcpb.mjs [out.mcpb]
//
// CI runs it on every GitHub release and attaches the file (.github/workflows/mcpb.yml).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const MCPB = '@anthropic-ai/mcpb@2.1.2';
const out = resolve(process.argv[2] ?? 'edgegap-mcp.mcpb');
const stage = resolve('.mcpb-stage');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

if (manifest.version !== pkg.version) throw new Error(`manifest.json is ${manifest.version}, package.json is ${pkg.version}`);
if (!existsSync('dist/index.js')) throw new Error('dist/ is missing: run npm run build first');

const win = process.platform === 'win32';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win });

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
for (const f of ['manifest.json', 'icon.png', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) cpSync(f, join(stage, f));
cpSync('dist', join(stage, 'dist'), { recursive: true });
// Runtime dependencies only, exactly as locked; no install scripts.
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
rmSync(join(stage, 'package-lock.json'));

run('npx', ['-y', MCPB, 'validate', join(stage, 'manifest.json')]);
rmSync(out, { force: true });
run('npx', ['-y', MCPB, 'pack', stage, out]);
rmSync(stage, { recursive: true, force: true });
console.log(`build-mcpb: wrote ${out} (${pkg.name} ${pkg.version})`);
