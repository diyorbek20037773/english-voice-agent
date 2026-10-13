// REAL end-to-end smoke + latency test against a running server (local or Railway).
// Costs real (small) OpenAI money: ~20 short Quick answers on gpt-6-luna is
// well under $0.01. Prints and saves timings only (no secrets).
//
//   pnpm smoke:real                                   # http://localhost:3000, token from .env
//   pnpm smoke:real --url https://<app>.up.railway.app --env railway-variables/web.env
//   pnpm smoke:real --latency 20                      # 20-question latency run (Quick)
import { mkdirSync, writeFileSync } from 'node:fs';
import { SseParser } from '../shared/sse.ts';
import type { AnswerEvent } from '../shared/stream-events.ts';
import { readEnvFile } from './lib/envfile.ts';

const args = process.argv.slice(2);
const arg = (n: string, d: string) => (args.includes(n) ? args[args.indexOf(n) + 1]! : d);
const base = arg('--url', 'http://localhost:3000').replace(/\/+$/, '');
const token = readEnvFile(arg('--env', '.env')).APP_ACCESS_TOKEN;
const latencyRuns = Number(arg('--latency', '0'));
const origin = new URL(base).origin;
if (!token) throw new Error('APP_ACCESS_TOKEN not found in the env file.');

const QUESTIONS = [
  'What is the difference between a process and a thread?',
  'Explain what a REST API is.',
  'What is a race condition?',
  'How does a hash map handle collisions?',
  'What is the CAP theorem?',
  'What is the difference between SQL and NoSQL databases?',
  'Explain database indexing.',
  'What is eventual consistency?',
  'What does idempotent mean for an HTTP method?',
  'What is the difference between TCP and UDP?',
  'Explain dependency injection.',
  'What is a closure in JavaScript?',
  'What is the event loop in Node.js?',
  'How would you reverse a linked list?',
  'What is Big O notation?',
  'Explain the difference between authentication and authorization.',
  'What is a deadlock and how can you prevent it?',
  'What is horizontal versus vertical scaling?',
  'How does HTTPS protect data in transit?',
  'What is a message queue used for?',
];

let cookie = '';
const headers = () => ({ 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) });

async function post(path: string, body: unknown = {}) {
  return fetch(base + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
}

async function ask(sid: string, question: string, mode: 'quick' | 'detailed') {
  const questionId = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let t0 = performance.now();
  let res = await post('/api/answer', { practiceSessionId: sid, questionId, question, mode, kind: 'question', inputMode: 'typed' });
  // Our own per-minute limit answers before any OpenAI call (not billed): wait it out, then retry.
  for (let i = 0; i < 3 && res.status === 429; i++) {
    const msg = await res.text();
    if (!msg.includes('rate_limited')) throw new Error(`answer HTTP 429: ${msg}`);
    const wait = Number(/in (\d+) seconds/.exec(msg)?.[1] ?? 30) + 1;
    console.log(`  (server rate limit: waiting ${wait} s)`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    t0 = performance.now();
    res = await post('/api/answer', { practiceSessionId: sid, questionId, question, mode, kind: 'question', inputMode: 'typed' });
  }
  if (!res.ok || !res.body) throw new Error(`answer HTTP ${res.status}: ${await res.text()}`);
  const parser = new SseParser();
  const dec = new TextDecoder();
  let first: number | null = null;
  let chars = 0;
  let deltas = 0;
  let last: AnswerEvent | null = null;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    for (const m of parser.push(dec.decode(chunk, { stream: true }))) {
      const ev = JSON.parse(m.data) as AnswerEvent;
      if (ev.type === 'answer.delta') {
        first ??= performance.now() - t0;
        chars += ev.delta.length;
        deltas++;
      } else last = ev;
    }
  }
  return { firstTextMs: first === null ? null : Math.round(first), totalMs: Math.round(performance.now() - t0), chars, deltas, end: last };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]! : null;
};

const report: Record<string, unknown> = { at: new Date().toISOString(), base, client: `${process.platform} node ${process.version}` };

// 1. health + unauthenticated rejection
const health = await fetch(`${base}/healthz`);
console.log(`healthz: HTTP ${health.status}`);
const unauth = await post('/api/realtime/session');
console.log(`unauthenticated realtime session: HTTP ${unauth.status} (expected 401)`);
// 2. unlock
const login = await post('/api/login', { token });
if (!login.ok) throw new Error(`login HTTP ${login.status}`);
cookie = login.headers.getSetCookie()[0]!.split(';')[0]!;
const cfg = (await (await fetch(`${base}/api/config`, { headers: headers() })).json()) as Record<string, unknown>;
console.log('config:', JSON.stringify(cfg));
report.config = cfg;
// 3. model access (free)
const models = await (await post('/api/models/check')).json();
console.log('model access:', JSON.stringify(models));
report.models = models;
// 4. realtime transcription session (creating the ephemeral token is free)
const t0 = performance.now();
const rt = await post('/api/realtime/session');
const rtBody = (await rt.json()) as { clientSecret?: string; expiresAt?: number; model?: string; error?: unknown };
const rtMs = Math.round(performance.now() - t0);
console.log(
  `realtime session: HTTP ${rt.status} in ${rtMs} ms, token ${rtBody.clientSecret ? `prefix ${rtBody.clientSecret.slice(0, 3)} len ${rtBody.clientSecret.length}` : 'missing'}, expires in ${rtBody.expiresAt ? rtBody.expiresAt - Math.floor(Date.now() / 1000) : '?'} s, cache-control=${rt.headers.get('cache-control')}`,
);
report.realtimeSession = { status: rt.status, ms: rtMs, tokenPrefix: rtBody.clientSecret?.slice(0, 3) ?? null, error: rtBody.error ?? null };
// 5. answers
const sid = ((await (await post('/api/practice-sessions')).json()) as { id: string }).id;
const quick = await ask(sid, 'What is the difference between a stack and a queue?', 'quick');
console.log(`quick answer: first text ${quick.firstTextMs} ms, full ${quick.totalMs} ms, ${quick.deltas} deltas, ${quick.chars} chars, end=${quick.end?.type}`);
const follow = await ask(sid, 'And which one would you use for breadth-first search?', 'quick');
console.log(`follow-up answer: first text ${follow.firstTextMs} ms, full ${follow.totalMs} ms, end=${follow.end?.type}`);
const detailed = await ask(sid, 'How would you design a URL shortener?', 'detailed');
console.log(`detailed answer: first text ${detailed.firstTextMs} ms, full ${detailed.totalMs} ms, ${detailed.chars} chars, end=${detailed.end?.type} truncated=${detailed.end?.type === 'answer.done' ? detailed.end.truncated : '-'}`);
report.answers = { quick, follow, detailed };

// 6. latency run
if (latencyRuns > 0) {
  const rows: { q: string; firstTextMs: number | null; totalMs: number; ok: boolean }[] = [];
  for (let i = 0; i < latencyRuns; i++) {
    const q = QUESTIONS[i % QUESTIONS.length]!;
    const s = ((await (await post('/api/practice-sessions')).json()) as { id: string }).id; // no history: comparable runs
    const r = await ask(s, q, 'quick');
    rows.push({ q, firstTextMs: r.firstTextMs, totalMs: r.totalMs, ok: r.end?.type === 'answer.done' });
    console.log(`  ${String(i + 1).padStart(2)}. first ${r.firstTextMs} ms · full ${r.totalMs} ms · ${r.end?.type}`);
  }
  const firsts = rows.filter((r) => r.ok && r.firstTextMs !== null).map((r) => r.firstTextMs!);
  const totals = rows.filter((r) => r.ok).map((r) => r.totalMs);
  const misses = rows.filter((r) => !r.ok || (r.firstTextMs ?? Infinity) > 3000).length;
  const summary = {
    runs: rows.length,
    ok: rows.filter((r) => r.ok).length,
    firstText: { p50: pct(firsts, 50), p95: pct(firsts, 95) },
    fullAnswer: { p50: pct(totals, 50), p95: pct(totals, 95) },
    over3sOrFailed: misses,
  };
  console.log('latency summary (answer request → first text, measured by this HTTP client):', JSON.stringify(summary));
  report.latency = { summary, rows };
  const server = await (await fetch(`${base}/api/timings/summary?mode=quick`, { headers: headers() })).json();
  report.serverTimings = server;
}

mkdirSync('docs/results', { recursive: true });
const file = `docs/results/smoke-${new URL(base).hostname.replace(/[^a-z0-9]+/gi, '-')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(`saved ${file}`);
