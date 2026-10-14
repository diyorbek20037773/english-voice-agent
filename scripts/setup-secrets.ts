// Creates/updates gitignored env files. Prints variable NAMES and status only —
// never values. Safe to re-run: existing real values are kept.
//
//   pnpm setup:secrets                                  # generate access tokens
//   pnpm setup:secrets --openai-key-file docs/apikey.md # also copy your OpenAI key in
//
// Files:
//   .env                       local development (pnpm dev / pnpm start)
//   railway-variables/web.env  paste into Railway → service → Variables → Raw Editor
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readEnvFile, upsertEnvFile, isPlaceholder } from './lib/envfile.ts';

const args = process.argv.slice(2);
const keyFile = args.includes('--openai-key-file') ? args[args.indexOf('--openai-key-file') + 1] : undefined;

// 30 characters from an unambiguous alphabet (~150 bits), grouped for typing on a phone.
function accessToken(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups: string[] = [];
  for (let g = 0; g < 6; g++) {
    let s = '';
    for (let i = 0; i < 5; i++) s += alphabet[randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}

let openAiKey: string | undefined;
if (keyFile) {
  const matches = readFileSync(keyFile, 'utf8').match(/sk-[A-Za-z0-9_-]{20,}/g) ?? [];
  if (matches.length !== 1) {
    console.error(`Expected exactly one OpenAI key (sk-...) in ${keyFile}, found ${matches.length}.`);
    process.exit(2);
  }
  openAiKey = matches[0];
}

const status: string[] = [];
function keepOr(existing: Record<string, string>, key: string, make: () => string | undefined, where: string): string {
  const v = existing[key];
  if (!isPlaceholder(v) && !v?.startsWith('PASTE_')) {
    status.push(`  kept       ${key} (${where})`);
    return v!;
  }
  const made = make();
  if (made) {
    status.push(`  set        ${key} (${where})`);
    return made;
  }
  status.push(`  MISSING    ${key} (${where})`);
  return 'PASTE_YOUR_OPENAI_API_KEY_HERE';
}

const models = {
  OPENAI_TRANSCRIPTION_MODEL: 'gpt-live-transcribe',
  OPENAI_ANSWER_MODEL: 'gpt-6-luna',
  OPENAI_QUICK_REASONING: 'none',
  OPENAI_DETAILED_REASONING: 'low',
};

// ---------- local .env ----------
const local = readEnvFile('.env');
upsertEnvFile(
  '.env',
  {
    OPENAI_API_KEY: keepOr(local, 'OPENAI_API_KEY', () => openAiKey, 'local'),
    APP_ACCESS_TOKEN: keepOr(local, 'APP_ACCESS_TOKEN', accessToken, 'local'),
    ...Object.fromEntries(Object.entries(models).map(([k, v]) => [k, local[k] || v])),
  },
  '.env.example',
);

// ---------- production (Railway) ----------
const web = readEnvFile('railway-variables/web.env');
// Railway's Raw Editor: plain KEY=value lines, no quotes. ALLOWED_ORIGIN is not needed on Railway:
// the server defaults it to https://$RAILWAY_PUBLIC_DOMAIN, which Railway provides automatically.
upsertEnvFile(
  'railway-variables/web.env',
  {
    NODE_ENV: 'production',
    PORT: '3000',
    TRUST_PROXY_HOPS: '1',
    APP_ACCESS_TOKEN: keepOr(web, 'APP_ACCESS_TOKEN', accessToken, 'railway'),
    OPENAI_API_KEY: keepOr(web, 'OPENAI_API_KEY', () => openAiKey, 'railway'),
    ...Object.fromEntries(Object.entries(models).map(([k, v]) => [k, web[k] || v])),
    ...(web.OPENAI_ANSWER_MODEL_DETAILED ? { OPENAI_ANSWER_MODEL_DETAILED: web.OPENAI_ANSWER_MODEL_DETAILED } : {}),
    ANSWER_DAILY_LIMIT: web.ANSWER_DAILY_LIMIT || '200',
  },
  undefined,
  { quote: false, remove: ['ALLOWED_ORIGIN', 'HOST', 'OPENAI_REALTIME_MODEL', ...(web.OPENAI_ANSWER_MODEL_DETAILED ? [] : ['OPENAI_ANSWER_MODEL_DETAILED'])] },
);

console.log('Env files ready (secret values are only inside these gitignored files):');
console.log(status.join('\n'));
console.log('\nFiles: .env (local), railway-variables/web.env (paste into Railway Raw Editor)');
if (status.some((s) => s.includes('MISSING'))) {
  console.log('\nOPENAI_API_KEY is missing. Re-run with: pnpm setup:secrets --openai-key-file <file containing your key>');
}
console.log('Your access tokens (APP_ACCESS_TOKEN) are inside those files; open them to read the value.');
