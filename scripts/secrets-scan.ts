// Fails if a secret could leak: scans the built browser assets (dist/web) and
// every file git would commit. Checks the exact secret values from local env
// files plus key-shaped patterns. Prints file names only, never values.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readEnvFile } from './lib/envfile.ts';

const secretValues = new Map<string, string>();
for (const file of ['.env', 'railway-variables/web.env']) {
  const env = readEnvFile(file);
  for (const key of ['OPENAI_API_KEY', 'APP_ACCESS_TOKEN']) {
    const v = env[key];
    if (v && v.length >= 16 && !v.startsWith('PASTE_') && v !== 'generated') secretValues.set(`${key} from ${file}`, v);
  }
}

const PATTERNS: [string, RegExp][] = [
  ['OpenAI key pattern', /sk-(?!test-)[A-Za-z0-9_-]{20,}/],
  ['ephemeral token pattern', /\bek_(?!mock_)[A-Za-z0-9]{16,}/],
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

let gitFiles: string[] = [];
try {
  gitFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  console.warn('git not available: scanning dist/ only');
}

const files = [...new Set([...walk('dist/web'), ...gitFiles])].filter((f) => existsSync(f) && statSync(f).size < 5_000_000);
const problems: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const [label, value] of secretValues) if (text.includes(value)) problems.push(`${file}: contains ${label}`);
  for (const [label, re] of PATTERNS) if (re.test(text)) problems.push(`${file}: matches ${label}`);
  if (file.startsWith(`dist${path.sep}web`) || file.startsWith('dist/web')) {
    if (/OPENAI_API_KEY|APP_ACCESS_TOKEN/.test(text)) problems.push(`${file}: browser asset references a server secret variable name`);
  }
}

console.log(`Scanned ${files.length} files (${secretValues.size} known secret values, ${PATTERNS.length} patterns).`);
if (problems.length) {
  console.error('SECRET LEAK RISK:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('No secrets found in browser assets or committable files.');
