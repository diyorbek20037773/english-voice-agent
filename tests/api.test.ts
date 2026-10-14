// Backend integration tests against a MOCKED OpenAI (mock-openai/server.mjs).
// Deterministic and free; they do not prove real OpenAI behavior.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, LOG_REDACT } from '../server/src/app.ts';
import { loadConfig } from '../server/src/config.ts';
import { SseParser } from '../shared/sse.ts';
import type { AnswerEvent } from '../shared/stream-events.ts';
import { createMockOpenAi } from '../mock-openai/server.mjs';

const TOKEN = 'abcde-fghjk-mnpqr-stuvw-xyz23';
type Mock = { listen: (p?: number) => Promise<string>; close: () => Promise<void>; requests: { path: string; body: any }[] };

let mock: Mock;
let mockUrl: string;
let base: string;
let origin: string;
let close: () => Promise<void>;
let logs = '';

async function startApp(env: Record<string, string> = {}, webDir: string | null = null) {
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logs += chunk.toString();
      cb();
    },
  });
  const config = loadConfig({
    OPENAI_API_KEY: 'sk-test-mock-0123456789abcdefghij',
    OPENAI_BASE_URL: `${mockUrl}/v1`,
    APP_ACCESS_TOKEN: TOKEN,
    ALLOWED_ORIGIN: 'http://localhost:5173',
    LOG_LEVEL: 'info',
    ...env,
  } as NodeJS.ProcessEnv);
  const { app } = await buildApp({ config, webDir, logger: { level: 'info', stream: logStream, redact: { paths: LOG_REDACT, censor: '[redacted]' } } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return { url, app };
}

beforeAll(async () => {
  mock = createMockOpenAi() as Mock;
  mockUrl = await mock.listen(0);
  const started = await startApp();
  base = started.url;
  origin = 'http://localhost:5173';
  close = () => started.app.close();
});

afterAll(async () => {
  await close();
  await mock.close();
});

const h = (cookie?: string) => ({ 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) });

const cookies = new Map<string, string>();
/** One real login per server (the login route is rate-limited to 5/minute per IP). */
async function login(url = base): Promise<string> {
  const cached = cookies.get(url);
  if (cached) return cached;
  const res = await fetch(`${url}/api/login`, { method: 'POST', headers: h(), body: JSON.stringify({ token: TOKEN }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie()[0]!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  cookies.set(url, cookie.split(';')[0]!);
  return cookies.get(url)!;
}

async function newSession(cookie: string, url = base): Promise<string> {
  const res = await fetch(`${url}/api/practice-sessions`, { method: 'POST', headers: h(cookie), body: '{}' });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function answer(cookie: string, body: Record<string, unknown>, url = base) {
  const res = await fetch(`${url}/api/answer`, {
    method: 'POST',
    headers: h(cookie),
    body: JSON.stringify({ mode: 'quick', kind: 'question', inputMode: 'typed', ...body }),
  });
  if (res.headers.get('content-type')?.startsWith('application/json')) return { status: res.status, json: await res.json(), events: [] as AnswerEvent[] };
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const events: AnswerEvent[] = [];
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    for (const m of parser.push(decoder.decode(chunk, { stream: true }))) events.push(JSON.parse(m.data) as AnswerEvent);
  }
  return { status: res.status, json: null, events };
}

const text = (events: AnswerEvent[]) => events.map((e) => (e.type === 'answer.delta' ? e.delta : '')).join('');
const responsesCalls = () => mock.requests.filter((r) => r.path === '/v1/responses').length;

describe('health', () => {
  it('liveness reveals no configuration', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('authentication and CSRF', () => {
  it('rejects unauthenticated token and answer requests', async () => {
    for (const p of ['/api/realtime/session', '/api/answer', '/api/practice-sessions']) {
      const res = await fetch(`${base}${p}`, { method: 'POST', headers: h(), body: '{}' });
      expect(res.status).toBe(401);
    }
    expect((await fetch(`${base}/api/config`)).status).toBe(401);
  });

  it('rejects a wrong token, a forged cookie and an expired cookie', async () => {
    const bad = await fetch(`${base}/api/login`, { method: 'POST', headers: h(), body: JSON.stringify({ token: 'wrong-token-value' }) });
    expect(bad.status).toBe(401);
    const forged = await fetch(`${base}/api/config`, { headers: { Cookie: 'eva_session=eyJ2IjoxLCJleHAiOjk5OTk5OTk5OTk5OTl9.AAAA' } });
    expect(forged.status).toBe(401);
    const good = await login();
    const [payload, sig] = good.split('=')[1]!.split('.');
    const tampered = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 1e12 })).toString('base64url');
    expect((await fetch(`${base}/api/config`, { headers: { Cookie: `eva_session=${tampered}.${sig}` } })).status).toBe(401);
    expect((await fetch(`${base}/api/config`, { headers: { Cookie: `eva_session=${payload}.${sig}` } })).status).toBe(200);
  });

  it('rejects state-changing requests from another origin', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/practice-sessions`, { method: 'POST', headers: { ...h(cookie), Origin: 'https://evil.example' }, body: '{}' });
    expect(res.status).toBe(403);
    const noOrigin = await fetch(`${base}/api/practice-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    expect(noOrigin.status).toBe(403);
  });

  it('refuses text/plain bodies (no CORS-simple requests)', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/practice-sessions`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: origin, Cookie: cookie }, body: '{}' });
    expect(res.status).toBe(415);
  });
});

describe('realtime transcription session', () => {
  it('returns only the ephemeral token, uncached, and never logs it', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/realtime/session`, { method: 'POST', headers: h(cookie), body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = (await res.json()) as { clientSecret: string; expiresAt: number; model: string; rtcUrl: string };
    expect(Object.keys(body).sort()).toEqual(['clientSecret', 'expiresAt', 'model', 'rtcUrl']);
    expect(body.clientSecret).toMatch(/^ek_mock_/);
    expect(logs).not.toContain(body.clientSecret);
    expect(logs).not.toContain('sk-test-mock');
    const sent = mock.requests.filter((r) => r.path === '/v1/realtime/client_secrets').at(-1)!;
    expect(sent.body.session.audio.input.transcription).toMatchObject({ model: 'gpt-live-transcribe', languages: ['en'] });
    expect(sent.body.session.audio.input.turn_detection).toBeNull();
    expect(sent.body.expires_after.seconds).toBe(60);
  });
});

describe('answer streaming', () => {
  it('streams normalized events with request/question ids and documented OpenAI parameters', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_happy_0001', question: 'What is eventual consistency?' });
    expect(r.status).toBe(200);
    const deltas = r.events.filter((e) => e.type === 'answer.delta');
    expect(deltas.length).toBeGreaterThan(3);
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.done', truncated: false, replayed: false, model: 'gpt-6-luna' });
    expect(new Set(r.events.map((e) => e.questionId))).toEqual(new Set(['q_happy_0001']));
    expect(new Set(r.events.map((e) => e.requestId)).size).toBe(1);
    expect(text(r.events)).toContain('What is eventual consistency?');
    const sent = mock.requests.filter((x) => x.path === '/v1/responses').at(-1)!.body;
    expect(sent).toMatchObject({ model: 'gpt-6-luna', stream: true, store: false, reasoning: { effort: 'none' }, max_output_tokens: 700 });
    expect(sent).not.toHaveProperty('temperature');
  });

  it('passes multi-byte text through intact', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_unicode_01', question: 'UNICODE_TEST' });
    expect(text(r.events)).toBe('Привет — naïve café 🚀 oʻzbekcha 日本語 ✓ done.');
  });

  it('does not call OpenAI twice for a duplicate submission', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const first = await answer(cookie, { practiceSessionId: sid, questionId: 'q_dup_000001', question: 'Explain idempotency' });
    const calls = responsesCalls();
    const second = await answer(cookie, { practiceSessionId: sid, questionId: 'q_dup_000001', question: 'Explain idempotency' });
    expect(responsesCalls()).toBe(calls);
    expect(second.events.at(-1)).toMatchObject({ type: 'answer.done', replayed: true });
    expect(text(second.events)).toBe(text(first.events));
  });

  it('rejects a duplicate while the first is still streaming', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const p = answer(cookie, { practiceSessionId: sid, questionId: 'q_dupslow_01', question: 'SLOW_TEST' });
    await new Promise((r) => setTimeout(r, 200));
    const dup = await answer(cookie, { practiceSessionId: sid, questionId: 'q_dupslow_01', question: 'SLOW_TEST' });
    expect(dup.status).toBe(409);
    await p;
  });

  it('a newer question supersedes the active one in the same session', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const slow = answer(cookie, { practiceSessionId: sid, questionId: 'q_old_00001', question: 'SLOW_TEST' });
    await new Promise((r) => setTimeout(r, 400));
    const fresh = await answer(cookie, { practiceSessionId: sid, questionId: 'q_new_00001', question: 'What is a queue?' });
    const old = await slow;
    expect(old.events.at(-1)).toMatchObject({ type: 'answer.error', code: 'superseded', questionId: 'q_old_00001' });
    expect(fresh.events.at(-1)).toMatchObject({ type: 'answer.done', questionId: 'q_new_00001' });
    expect(fresh.events.every((e) => e.questionId === 'q_new_00001')).toBe(true);
  });

  it('maps insufficient quota to a clear, non-retryable error', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_quota_0001', question: 'QUOTA_TEST' });
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.error', code: 'insufficient_credit', retryable: false });
    expect((r.events.at(-1) as { message: string }).message).toMatch(/insufficient credit/);
  });

  it('reports an error event when the upstream connection drops mid-stream', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_drop_00001', question: 'DROP_TEST' });
    expect(text(r.events)).toBe('Partial answer ');
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.error', code: 'upstream_error' });
  });

  it('reports response.failed after streaming started', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_fail_00001', question: 'FAIL_TEST' });
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.error' });
  });

  it('retries once on a 5xx before any text, without duplicating output', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const before = responsesCalls();
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_retry_0001', question: 'SERVER_ERROR_ONCE please' });
    expect(responsesCalls() - before).toBe(2);
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.done' });
  });

  it('marks incomplete answers as truncated and supports Continue', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    const r = await answer(cookie, { practiceSessionId: sid, questionId: 'q_long_00001', question: 'LONG_TEST' });
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.done', truncated: true });
    const c = await answer(cookie, { practiceSessionId: sid, questionId: 'q_cont_00001', question: 'Continue', kind: 'continue', continueOf: 'q_long_00001' });
    expect(c.events.at(-1)).toMatchObject({ type: 'answer.done' });
    const sent = mock.requests.filter((x) => x.path === '/v1/responses').at(-1)!.body;
    expect(JSON.stringify(sent.input)).toContain('<previous_answer>');
  });

  it('sends recent turns as follow-up context', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    await answer(cookie, { practiceSessionId: sid, questionId: 'q_ctx_000001', question: 'What is TCP?' });
    await answer(cookie, { practiceSessionId: sid, questionId: 'q_ctx_000002', question: 'And how is it different from UDP?' });
    const input = mock.requests.filter((x) => x.path === '/v1/responses').at(-1)!.body.input as { role: string; content: string }[];
    expect(input.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(input[0]!.content).toContain('What is TCP?');
  });

  it('returns 404 for an unknown practice session', async () => {
    const cookie = await login();
    const r = await answer(cookie, { practiceSessionId: '00000000-0000-4000-8000-000000000000', questionId: 'q_nosess_001', question: 'Hi there?' });
    expect(r.status).toBe(404);
  });

  it('validates input size and fields', async () => {
    const cookie = await login();
    const sid = await newSession(cookie);
    expect((await answer(cookie, { practiceSessionId: sid, questionId: 'bad', question: 'x' })).status).toBe(400);
    expect((await answer(cookie, { practiceSessionId: sid, questionId: 'q_big_000001', question: 'x'.repeat(2001) })).status).toBe(400);
    expect((await answer(cookie, { practiceSessionId: sid, questionId: 'q_sys_000001', question: 'hi', system: 'evil' })).status).toBe(400);
  });
});

describe('limits and static hosting', () => {
  it('enforces the daily answer limit', async () => {
    const { url, app } = await startApp({ ANSWER_DAILY_LIMIT: '1' });
    const cookie = await login(url);
    const sid = await newSession(cookie, url);
    expect((await answer(cookie, { practiceSessionId: sid, questionId: 'q_limit_0001', question: 'One?' }, url)).status).toBe(200);
    const second = await answer(cookie, { practiceSessionId: sid, questionId: 'q_limit_0002', question: 'Two?' }, url);
    expect(second.status).toBe(429);
    expect(second.json).toMatchObject({ error: { code: 'daily_limit' } });
    await app.close();
  });

  it('rate-limits login attempts', async () => {
    const { url, app } = await startApp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await fetch(`${url}/api/login`, { method: 'POST', headers: h(), body: JSON.stringify({ token: 'nope-nope-nope' }) });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    await app.close();
  });

  it('serves the SPA with a strict CSP that only allows OpenAI as an external connection', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'eva-web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    const { url, app } = await startApp({}, dir);
    const res = await fetch(`${url}/some/deep/link`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'self' https://api.openai.com");
    expect(csp).toContain("script-src 'self'");
    expect(res.headers.get('permissions-policy')).toContain('microphone=(self)');
    expect(res.headers.get('permissions-policy')).toContain('display-capture=(self)');
    await app.close();
  });

  it('checks model availability through the free models endpoint', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/models/check`, { method: 'POST', headers: h(cookie), body: '{}' });
    expect(await res.json()).toEqual({ checked: true, available: { 'gpt-6-luna': true, 'gpt-live-transcribe': true } });
  });
});

describe('open access (OPEN_ACCESS=true, no unlock screen)', () => {
  it('lets the app in without any token and still works end to end', async () => {
    const { url, app } = await startApp({ OPEN_ACCESS: 'true', APP_ACCESS_TOKEN: '' });
    const me = await (await fetch(`${url}/api/me`)).json();
    expect(me).toEqual({ authenticated: true, openAccess: true });
    const s = await fetch(`${url}/api/practice-sessions`, { method: 'POST', headers: h(), body: '{}' });
    expect(s.status).toBe(201);
    const sid = ((await s.json()) as { id: string }).id;
    const r = await answer('', { practiceSessionId: sid, questionId: 'q_open_00001', question: 'What is a semaphore?' }, url);
    expect(r.events.at(-1)).toMatchObject({ type: 'answer.done' });
    const rt = await fetch(`${url}/api/realtime/session`, { method: 'POST', headers: h(), body: '{}' });
    expect(rt.status).toBe(200);
    // Cross-site requests are still refused.
    const evil = await fetch(`${url}/api/practice-sessions`, { method: 'POST', headers: { ...h(), Origin: 'https://evil.example' }, body: '{}' });
    expect(evil.status).toBe(403);
    expect((await fetch(`${url}/robots.txt`)).status).toBe(404); // no web dir in this test; header still set:
    expect((await fetch(`${url}/healthz`)).headers.get('x-robots-tag')).toBe('noindex, nofollow');
    await app.close();
  });

  it('caps voice sessions per day for the budget', async () => {
    const { url, app } = await startApp({ OPEN_ACCESS: 'true', VOICE_SESSIONS_PER_DAY: '1' });
    expect((await fetch(`${url}/api/realtime/session`, { method: 'POST', headers: h(), body: '{}' })).status).toBe(200);
    const second = await fetch(`${url}/api/realtime/session`, { method: 'POST', headers: h(), body: '{}' });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { code: 'daily_limit' } });
    await app.close();
  });
});
