import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Auth } from '../auth.ts';
import type { MemoryState } from '../state.ts';
import type { AnswerService } from '../answer/service.ts';
import { buildTranscriptionSessionBody, type OpenAiClient } from '../openai/client.ts';
import { classifyOpenAiError, scrub } from '../answer/errors.ts';
import { ERROR_MESSAGES } from '../../../shared/stream-events.ts';
import type { AppConfigResponse, TimingSummaryRow } from '../../../shared/api-types.ts';

interface Deps {
  config: Config;
  auth: Auth;
  openai: OpenAiClient;
  state: MemoryState;
  answers: AnswerService;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const DEFAULT_KEYWORDS = [
  'TypeScript',
  'JavaScript',
  'React',
  'Node.js',
  'PostgreSQL',
  'Kubernetes',
  'Docker',
  'REST API',
  'GraphQL',
  'microservices',
  'idempotency',
  'Big O',
  'hash map',
  'binary search',
  'dynamic programming',
  'CI/CD',
];

const LoginBody = z.strictObject({ token: z.string().min(1).max(512) });

const AnswerBody = z.strictObject({
  practiceSessionId: z.uuid(),
  questionId: z.string().regex(ID_RE),
  question: z.string().trim().min(1).max(2000),
  mode: z.enum(['quick', 'detailed']),
  kind: z.enum(['question', 'continue']).default('question'),
  continueOf: z.string().regex(ID_RE).optional(),
  inputMode: z.enum(['voice', 'typed']).default('typed'),
});

const num = z.number().finite().min(0).max(600_000).optional();
const TimingsBody = z.strictObject({
  practiceSessionId: z.uuid().optional(),
  questionId: z.string().regex(ID_RE).optional(),
  mode: z.enum(['quick', 'detailed']).optional(),
  model: z.string().max(64).optional(),
  inputMode: z.enum(['voice', 'typed']),
  metrics: z.strictObject({
    firstPartialMs: num,
    endOfSpeechToFinalMs: num,
    answerRequestToFirstTextMs: num,
    endOfSpeechToFirstAnswerMs: num,
    fullAnswerMs: num,
  }),
});

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

const apiError = (code: string, message: string) => ({ error: { code, message } });

export async function registerApiRoutes(api: FastifyInstance, d: Deps): Promise<void> {
  const { config, auth, openai, state, answers } = d;
  const authed = { preHandler: auth.requireAuth };

  api.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  // ---------- access ----------
  api.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = LoginBody.parse(req.body);
    if (auth.open) return reply.send({ authenticated: true, openAccess: true });
    if (auth.isLockedOut()) return reply.code(429).send(apiError('locked', 'Too many failed attempts. Try again in 15 minutes.'));
    if (!auth.checkToken(body.token)) {
      req.log.warn('login failed');
      return reply.code(401).send(apiError('invalid_token', 'That access token is not correct.'));
    }
    auth.issue(reply);
    return reply.send({ authenticated: true });
  });

  api.post('/logout', async (_req, reply) => {
    auth.clear(reply);
    return reply.send({ authenticated: false });
  });

  api.get('/me', async (req, reply) => reply.send({ authenticated: auth.isAuthenticated(req), openAccess: auth.open }));

  api.get('/config', authed, async (_req, reply) => {
    const body: AppConfigResponse = {
      modes: config.modes,
      transcriptionModel: config.OPENAI_TRANSCRIPTION_MODEL,
      profileConfigured: config.CANDIDATE_PROFILE.trim().length > 0,
      dailyLimit: config.ANSWER_DAILY_LIMIT,
      answersToday: state.answersToday(),
      openAccess: config.OPEN_ACCESS,
      voiceSessionsToday: state.voiceSessionsToday(),
      voiceSessionsPerDay: config.VOICE_SESSIONS_PER_DAY,
    };
    return reply.send(body);
  });

  // ---------- practice sessions (in memory) ----------
  api.post('/practice-sessions', authed, async (_req, reply) => {
    const s = state.createSession();
    return reply.code(201).send({ id: s.id, createdAt: new Date(s.createdAt).toISOString() });
  });

  // ---------- OpenAI Realtime transcription session (ephemeral token) ----------
  api.post(
    '/realtime/session',
    { ...authed, config: { rateLimit: { max: config.VOICE_SESSIONS_PER_HOUR, timeWindow: '1 hour' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
      if (state.voiceSessionsToday() >= config.VOICE_SESSIONS_PER_DAY) {
        return reply.code(429).send(apiError('daily_limit', 'The daily voice session limit was reached. It resets at midnight (Asia/Tashkent). Typed questions still work.'));
      }
      const body = buildTranscriptionSessionBody({
        model: config.OPENAI_TRANSCRIPTION_MODEL,
        keywords: config.TRANSCRIPTION_KEYWORDS.length ? config.TRANSCRIPTION_KEYWORDS : DEFAULT_KEYWORDS,
        ttlSeconds: config.VOICE_TOKEN_TTL_SECONDS,
      });
      let result: Awaited<ReturnType<OpenAiClient['createClientSecret']>> | null = null;
      // One deliberate retry on network failure only; creating a client secret is not billed.
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          result = await openai.createClientSecret(body);
        } catch (err) {
          req.log.warn({ attempt, err: scrub((err as Error).message) }, 'realtime session request failed');
        }
      }
      if (!result) return reply.code(502).send(apiError('upstream_error', 'Could not reach OpenAI. Check your connection and try again.'));
      const json = result.json ?? {};
      if (result.status === 200 && typeof json.value === 'string' && json.value) {
        state.countVoiceSession();
        // Only the ephemeral token and non-secret settings go to the browser. Never logged.
        return reply.send({
          clientSecret: json.value,
          expiresAt: typeof json.expires_at === 'number' ? json.expires_at : null,
          model: config.OPENAI_TRANSCRIPTION_MODEL,
          rtcUrl: `${config.OPENAI_BASE_URL.startsWith('https://api.openai.com') ? 'https://api.openai.com/v1' : config.OPENAI_BASE_URL}/realtime/calls`,
        });
      }
      const err = (json.error ?? {}) as { code?: string; type?: string; message?: string };
      const code = classifyOpenAiError(result.status, err.code ?? err.type, err.message);
      req.log.warn({ status: result.status, code, detail: scrub(err.message) }, 'realtime session rejected');
      return reply.code(code === 'rate_limited' ? 429 : 502).send(apiError(code, ERROR_MESSAGES[code]));
    },
  );

  // ---------- answer (streams OpenAI Responses API) ----------
  api.post(
    '/answer',
    { ...authed, config: { rateLimit: { max: config.ANSWER_RATE_PER_MINUTE, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = AnswerBody.parse(req.body);
      const pre = answers.preflight(body);
      if (!pre.ok) return reply.code(pre.status).send(apiError(pre.code, pre.message));
      reply.hijack();
      await pre.run(reply.raw);
    },
  );

  // ---------- model availability (explicit action; GET /v1/models is free) ----------
  api.post('/models/check', { ...authed, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const wanted = [...new Set([config.modes.quick.model, config.modes.detailed.model, config.OPENAI_TRANSCRIPTION_MODEL])];
    try {
      const res = await openai.listModels();
      if (res.status !== 200) {
        const code = classifyOpenAiError(res.status, res.error?.code, res.error?.message);
        return reply.send({ checked: false, available: {}, message: ERROR_MESSAGES[code] });
      }
      const ids = new Set(res.ids);
      return reply.send({ checked: true, available: Object.fromEntries(wanted.map((m) => [m, ids.has(m)])) });
    } catch {
      return reply.send({ checked: false, available: {}, message: 'Could not reach OpenAI to check models.' });
    }
  });

  // ---------- timings (timing-only, in memory) ----------
  api.post('/timings', { ...authed, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const t = TimingsBody.parse(req.body);
    const metrics = Object.fromEntries(
      Object.entries(t.metrics)
        .filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => [k, Math.round(v!)]),
    );
    state.addTiming({ at: Date.now(), source: 'client', mode: t.mode ?? null, model: t.model ?? null, inputMode: t.inputMode, metrics });
    req.log.info({ questionId: t.questionId, mode: t.mode, inputMode: t.inputMode, ...metrics }, 'client timing');
    return reply.code(204).send();
  });

  api.get<{ Querystring: { mode?: string } }>('/timings/summary', authed, async (req, reply) => {
    const mode = req.query.mode === 'quick' || req.query.mode === 'detailed' ? req.query.mode : null;
    const byMetric = new Map<string, number[]>();
    for (const s of state.timings) {
      if (mode && s.mode !== mode) continue;
      for (const [k, v] of Object.entries(s.metrics)) {
        if (!byMetric.has(k)) byMetric.set(k, []);
        byMetric.get(k)!.push(v);
      }
    }
    const order = [
      'firstPartialMs',
      'endOfSpeechToFinalMs',
      'answerRequestToFirstTextMs',
      'endOfSpeechToFirstAnswerMs',
      'fullAnswerMs',
      'serverOpenAiHeadersMs',
      'serverFirstDeltaMs',
      'serverTotalMs',
    ];
    const rows: TimingSummaryRow[] = order.map((metric) => {
      const values = (byMetric.get(metric) ?? []).sort((a, b) => a - b);
      return { metric, count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
    });
    return reply.send({ rows, since: state.startedAt });
  });
}
