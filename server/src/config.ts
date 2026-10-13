import { z } from 'zod';
import { buildCatalog, effectiveEffort, isValidModelId, type ReasoningEffort } from '../../shared/models.ts';

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const effort = z.enum(['none', 'low', 'medium', 'high', 'xhigh']);
const modelId = z.string().refine(isValidModelId, 'invalid model id');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('::'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // OpenAI (the permanent key never leaves the backend)
  OPENAI_API_KEY: z.string().regex(/^sk-[A-Za-z0-9_-]{20,}$/, 'must be an OpenAI API key (sk-...)'),
  /** Test-only override (mock server). Production uses the default. */
  OPENAI_BASE_URL: z.url().default('https://api.openai.com/v1'),
  /** Not used by transcription-only sessions; kept for the documented env contract. */
  OPENAI_REALTIME_MODEL: z.string().default(''),
  OPENAI_TRANSCRIPTION_MODEL: modelId.default('gpt-live-transcribe'),
  OPENAI_ANSWER_MODEL: modelId.default('gpt-6-luna'),
  /** Detailed mode model; defaults to OPENAI_ANSWER_MODEL to protect a small budget. */
  OPENAI_ANSWER_MODEL_DETAILED: z.string().default(''),
  OPENAI_QUICK_REASONING: effort.default('none'),
  OPENAI_DETAILED_REASONING: effort.default('low'),
  TRANSCRIPTION_KEYWORDS: csv,
  CANDIDATE_PROFILE: z.string().max(4000).default(''),

  // Access
  APP_ACCESS_TOKEN: z.string().min(16, 'use at least 16 characters'),
  ALLOWED_ORIGIN: z.url(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  // Limits and timeouts
  ANSWER_DAILY_LIMIT: z.coerce.number().int().min(1).max(10000).default(200),
  ANSWER_RATE_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
  VOICE_SESSIONS_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
  VOICE_TOKEN_TTL_SECONDS: z.coerce.number().int().min(10).max(7200).default(60),
  ANSWER_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  ANSWER_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  ANSWER_TOTAL_TIMEOUT_MS: z.coerce.number().int().min(5000).default(120_000),
  TIMEZONE: z.string().default('Asia/Tashkent'),
});

export interface ModeProfile {
  model: string;
  /** null = omit the reasoning parameter (unknown model capabilities). */
  reasoningEffort: ReasoningEffort | null;
}

export type Config = Omit<z.infer<typeof schema>, 'OPENAI_ANSWER_MODEL_DETAILED'> & {
  isProduction: boolean;
  secureCookies: boolean;
  cookieName: string;
  modes: { quick: ModeProfile; detailed: ModeProfile };
};

const KNOWN_KEYS = Object.keys(schema.shape);

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}

/**
 * Normalizes values pasted into dashboards/.env files: trims whitespace and CR, drops a BOM and one
 * layer of matching surrounding quotes, and treats empty values as unset so defaults apply.
 */
export function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined) continue;
    let v = raw.replace(/^﻿/, '').trim();
    if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
    if (v !== '') out[key.trim()] = v;
  }
  // Enum-like values are case-insensitive (e.g. NODE_ENV=Production, LOG_LEVEL=INFO).
  for (const key of ['NODE_ENV', 'LOG_LEVEL', 'OPENAI_QUICK_REASONING', 'OPENAI_DETAILED_REASONING']) {
    if (out[key]) out[key] = out[key].toLowerCase();
  }
  // ALLOWED_ORIGIN defaults to the Railway public domain (Railway provides RAILWAY_PUBLIC_DOMAIN to every
  // deployment that has a generated domain). An unresolved reference ("https://" or "${{…}}") counts as unset.
  const origin = out.ALLOWED_ORIGIN;
  if (!origin || /^https?:\/\/?$/.test(origin) || origin.includes('${{')) {
    delete out.ALLOWED_ORIGIN;
    if (out.RAILWAY_PUBLIC_DOMAIN) out.ALLOWED_ORIGIN = `https://${out.RAILWAY_PUBLIC_DOMAIN}`;
  }
  return out;
}

/** Variables that look like misspellings of known ones (names only, never values). */
export function misspelledKeys(env: Record<string, unknown>): { found: string; meant: string }[] {
  const out: { found: string; meant: string }[] = [];
  for (const key of Object.keys(env)) {
    if (KNOWN_KEYS.includes(key) || key.startsWith('RAILWAY_') || key.length < 6) continue;
    const meant = KNOWN_KEYS.find((k) => editDistance(k, key) <= 2);
    if (meant) out.push({ found: key, meant });
  }
  return out;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const env = normalizeEnv(rawEnv);
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Print only variable names and the problem, never values.
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    const hints = misspelledKeys(env).map((m) => `  - Found "${m.found}" — did you mean "${m.meant}"? Rename it.`);
    if (parsed.error.issues.some((i) => i.path[0] === 'ALLOWED_ORIGIN')) {
      hints.push(
        '  - ALLOWED_ORIGIN is unset and RAILWAY_PUBLIC_DOMAIN is empty. On Railway: Settings → Networking → Generate Domain, then redeploy.',
      );
    }
    throw new Error(`Invalid or missing environment variables:\n${problems}${hints.length ? `\nHints:\n${hints.join('\n')}` : ''}`);
  }
  const { OPENAI_ANSWER_MODEL_DETAILED, ...c } = parsed.data;
  const origin = new URL(c.ALLOWED_ORIGIN);
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !isLocalhost) throw new Error('ALLOWED_ORIGIN must use https:// except for localhost.');
  const detailedModel = OPENAI_ANSWER_MODEL_DETAILED || c.OPENAI_ANSWER_MODEL;
  if (!isValidModelId(detailedModel)) throw new Error('OPENAI_ANSWER_MODEL_DETAILED: invalid model id');
  const catalog = buildCatalog([c.OPENAI_ANSWER_MODEL, detailedModel]);
  const secureCookies = origin.protocol === 'https:';
  return {
    ...c,
    ALLOWED_ORIGIN: origin.origin,
    OPENAI_BASE_URL: c.OPENAI_BASE_URL.replace(/\/+$/, ''),
    isProduction: c.NODE_ENV === 'production',
    secureCookies,
    // __Host- prefix forces Secure, Path=/ and no Domain attribute.
    cookieName: secureCookies ? '__Host-eva_session' : 'eva_session',
    modes: {
      quick: { model: c.OPENAI_ANSWER_MODEL, reasoningEffort: effectiveEffort(catalog, c.OPENAI_ANSWER_MODEL, c.OPENAI_QUICK_REASONING) },
      detailed: { model: detailedModel, reasoningEffort: effectiveEffort(catalog, detailedModel, c.OPENAI_DETAILED_REASONING) },
    },
  };
}
