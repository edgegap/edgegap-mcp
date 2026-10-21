// Scans every tracked file for things that must never be committed: real
// credentials and the local paths of whoever wrote the code. Runs in CI and
// with `npm run scan`. Exit 1 on any hit.
//
// Test fixtures use obviously fake values ("fake-api-token", the docs' example
// UUID); a new fixture that trips a rule belongs in ALLOW below, with a reason.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const RULES = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ED25519 )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{20,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Cloudflare API token assignment', /CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{40}/],
  ['PostHog project key', /\bphc_[A-Za-z0-9]{40,}\b/],
  // An Edgegap API token written as an Authorization value.
  ['Edgegap API token', /\btoken\s+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  // Someone's machine, not the project.
  ['local Windows user path', /[A-Za-z]:\\\\?Users\\\\?(?!you\b|<|username\b|USER\b|%)[A-Za-z0-9._-]+/],
  ['local home path', /\/(?:home|Users)\/(?!you\b|user\b|runner\b|<|\$|USER\b|username\b|node\b)[a-z][a-z0-9._-]+\//],
];

// [file glob as a RegExp, rule name, why it is allowed]
const ALLOW = [
  [/^test\//, 'Edgegap API token', 'docs example UUID used as a fake token in fixtures'],
  [/^src\/skills\.generated\.ts$/, 'local home path', 'skill docs show example server paths under a home directory'],
];
// The example token from Edgegap's own docs, used across tests.
const EXAMPLE_TOKEN = /0f8b3c1e-e458-4592-b607-c2c28afd8b62|xxxxxxxx-e458-4592-b607-c2c28afd8b62/;

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const hits = [];
for (const file of files) {
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|gz|tgz)$/i.test(file)) continue;
  let text;
  try {
    if (statSync(file).size > 5_000_000) continue;
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of RULES) {
      if (!re.test(line)) continue;
      if (name === 'Edgegap API token' && EXAMPLE_TOKEN.test(line)) continue;
      if (ALLOW.some(([f, rule]) => f.test(file) && rule === name)) continue;
      hits.push(`${file}:${i + 1}: ${name}`);
    }
  });
}

if (hits.length) {
  console.log(`\nscan-repo: ${hits.length} finding(s)`);
  for (const h of hits) console.log(`  FAIL ${h}`);
  console.log('\nRemove the value (and rotate it if it is real), or add a reasoned entry to ALLOW in scripts/scan-repo.mjs.');
  process.exit(1);
}
console.log(`scan-repo: ${files.length} tracked files, no secrets or local paths.`);
