import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { encodeSse } from '../../../shared/sse.ts';
import { ERROR_MESSAGES, type AnswerErrorCode, type AnswerEvent, type AnswerKind, type AnswerMode } from '../../../shared/stream-events.ts';
import type { Config } from '../config.ts';
import type { OpenAiClient } from '../openai/client.ts';
import { ResponsesStreamAdapter, type ResponsesEvent } from '../openai/responses-stream.ts';
import type { MemoryState, PracticeSession, QuestionRecord } from '../state.ts';
import { classifyOpenAiError, isRetryable, scrub } from './errors.ts';
import { buildResponsesRequest, hasUnclosedFence } from './context.ts';

type AbortReason = 'superseded' | 'cancelled' | 'first_byte_timeout' | 'idle_timeout' | 'total_timeout';

export interface AnswerRequest {
  practiceSessionId: string;
  questionId: string;
  question: string;
  mode: AnswerMode;
  kind: AnswerKind;
  continueOf?: string | undefined;
  inputMode: 'voice' | 'typed';
  image?: string | undefined;
}

export type PreflightResult =
  | { ok: true; run: (raw: ServerResponse) => Promise<void> }
  | { ok: false; status: number; code: string; message: string };

class SseWriter {
  closed = false;

  constructor(private readonly raw: ServerResponse) {
    raw.on('close', () => {
      this.closed = true;
    });
  }

  start(): void {
    this.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    this.raw.socket?.setNoDelay(true);
    this.raw.flushHeaders();
  }

  send(event: AnswerEvent): Promise<void> {
    return this.write(encodeSse(event.type, event));
  }

  comment(text: string): Promise<void> {
    return this.write(`: ${text}\n\n`);
  }

  private async write(s: string): Promise<void> {
    if (this.closed || this.raw.writableEnded) return;
    if (!this.raw.write(s)) {
      // Respect backpressure: wait until the socket drains or the client leaves.
      await Promise.race([once(this.raw, 'drain'), once(this.raw, 'close')]);
    }
  }

  end(): void {
    if (!this.closed && !this.raw.writableEnded) this.raw.end();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AnswerService {
  constructor(
    private readonly deps: { config: Config; openai: OpenAiClient; state: MemoryState; log: FastifyBaseLogger },
  ) {}

  /**
   * Ownership, deduplication and limits are checked before streaming starts, so
   * those failures are plain JSON HTTP errors.
   */
  preflight(r: AnswerRequest): PreflightResult {
    const { state, config } = this.deps;
    const session = state.getSession(r.practiceSessionId);
    if (!session) return { ok: false, status: 404, code: 'session_not_found', message: 'Practice session not found. Start a new one.' };

    // Deduplicate by session + questionId: OpenAI is never called twice for the same question.
    const existing = session.questions.get(r.questionId);
    if (existing) {
      if (existing.status === 'streaming') return { ok: false, status: 409, code: 'duplicate_in_progress', message: 'This question is already being answered.' };
      return { ok: true, run: (raw) => this.replay(raw, existing) };
    }

    if (state.answersToday() >= config.ANSWER_DAILY_LIMIT) {
      return { ok: false, status: 429, code: 'daily_limit', message: ERROR_MESSAGES.daily_limit };
    }

    let question = r.question;
    let previousAnswer = '';
    if (r.kind === 'continue') {
      const prev = r.continueOf ? session.questions.get(r.continueOf) : undefined;
      if (!prev || prev.status !== 'done') return { ok: false, status: 409, code: 'nothing_to_continue', message: 'There is no completed answer to continue.' };
      question = prev.question;
      previousAnswer = prev.answer;
    }

    const profile = config.modes[r.mode];
    const record: QuestionRecord = {
      questionId: r.questionId,
      requestId: randomUUID(),
      status: 'streaming',
      question,
      answer: '',
      truncated: false,
      errorCode: null,
      mode: r.mode,
      model: profile.model,
    };
    state.recordQuestion(session, record);
    state.countAnswer();

    const { body, maxOutputTokens } = buildResponsesRequest({
      mode: r.mode,
      kind: r.kind,
      question,
      history: r.kind === 'continue' ? [] : session.turns.slice(-3),
      previousAnswer,
      image: r.kind === 'image' ? r.image : undefined,
      profile: config.CANDIDATE_PROFILE,
      targetRole: config.TARGET_ROLE,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
    });
    return { ok: true, run: (raw) => this.generate(raw, session, record, r, body, maxOutputTokens) };
  }

  private async replay(raw: ServerResponse, q: QuestionRecord): Promise<void> {
    const w = new SseWriter(raw);
    w.start();
    const ids = { requestId: q.requestId, questionId: q.questionId };
    if (q.status === 'done') {
      if (q.answer) await w.send({ type: 'answer.delta', ...ids, delta: q.answer });
      await w.send({ type: 'answer.done', ...ids, truncated: q.truncated, replayed: true, model: q.model });
    } else {
      const code = q.errorCode ?? (q.status === 'superseded' ? 'superseded' : 'cancelled');
      await w.send({ type: 'answer.error', ...ids, code, message: ERROR_MESSAGES[code], retryable: false });
    }
    w.end();
  }

  private async generate(
    raw: ServerResponse,
    session: PracticeSession,
    q: QuestionRecord,
    r: AnswerRequest,
    body: Record<string, unknown>,
    maxOutputTokens: number,
  ): Promise<void> {
    const { config, openai, state, log } = this.deps;
    const t0 = performance.now();
    const ids = { requestId: q.requestId, questionId: q.questionId };
    const w = new SseWriter(raw);

    const controller = new AbortController();
    let abortReason: AbortReason | null = null;
    const abort = (reason: AbortReason) => {
      if (abortReason) return;
      abortReason = reason;
      controller.abort(new Error(reason));
    };

    // At most one active answer per session: a newer question replaces this one.
    session.active?.abort('superseded');
    session.active = { questionId: q.questionId, abort };

    let finished = false;
    raw.on('close', () => {
      if (!finished) abort('cancelled');
    });
    w.start();

    const totalTimer = setTimeout(() => abort('total_timeout'), config.ANSWER_TOTAL_TIMEOUT_MS);
    let idleTimer = setTimeout(() => abort('first_byte_timeout'), config.ANSWER_FIRST_BYTE_TIMEOUT_MS);
    const heartbeat = setInterval(() => void w.comment('ping'), 15_000);

    let firstDeltaMs: number | null = null;
    let headersMs: number | null = null;
    let errorCode: AnswerErrorCode | null = null;
    let errorDetail = '';
    let done: Extract<ResponsesEvent, { kind: 'done' }> | null = null;

    try {
      let res: Response | null = null;
      // One deliberate retry, only for 5xx/network failures before any text was produced.
      for (let attempt = 0; attempt < 2 && !res; attempt++) {
        try {
          const candidate = await openai.streamResponse(body, controller.signal);
          if (candidate.status >= 500 && attempt === 0) {
            await candidate.body?.cancel();
            await sleep(300);
            continue;
          }
          res = candidate;
        } catch (err) {
          if (abortReason || attempt === 1) throw err;
          await sleep(300);
        }
      }
      if (!res) throw new Error('no response');
      headersMs = Math.round(performance.now() - t0);

      if (!res.ok || !res.body) {
        const json = (await res.json().catch(() => null)) as { error?: { code?: string; type?: string; message?: string } } | null;
        errorCode = classifyOpenAiError(res.status, json?.error?.code ?? json?.error?.type, json?.error?.message);
        errorDetail = `HTTP ${res.status} ${scrub(json?.error?.code ?? json?.error?.type)}: ${scrub(json?.error?.message)}`;
      } else {
        const adapter = new ResponsesStreamAdapter();
        const handle = async (events: ResponsesEvent[]): Promise<boolean> => {
          for (const ev of events) {
            if (ev.kind === 'delta') {
              if (firstDeltaMs === null) firstDeltaMs = Math.round(performance.now() - t0);
              q.answer += ev.text;
              await w.send({ type: 'answer.delta', ...ids, delta: ev.text });
            } else if (ev.kind === 'done') {
              done = ev;
              return true;
            } else {
              errorCode = classifyOpenAiError(undefined, ev.code, ev.message);
              errorDetail = `${scrub(ev.code)}: ${scrub(ev.message)}`;
              return true;
            }
          }
          return false;
        };
        let stop = false;
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => abort('idle_timeout'), config.ANSWER_IDLE_TIMEOUT_MS);
          if (await handle(adapter.push(chunk))) {
            stop = true;
            break;
          }
        }
        if (!stop) await handle(adapter.end());
      }
    } catch (err) {
      if (!abortReason) {
        errorCode = classifyOpenAiError(undefined, undefined, (err as Error).message);
        errorDetail = scrub((err as Error).message);
      }
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(idleTimer);
      clearInterval(heartbeat);
      // Stop the upstream request in every case (no-op when it already finished).
      if (!controller.signal.aborted) controller.abort(new Error('finished'));
      if (session.active?.questionId === q.questionId) session.active = null;
    }

    const reason = abortReason as AbortReason | null;
    const doneEv = done as Extract<ResponsesEvent, { kind: 'done' }> | null;
    if (reason === 'superseded' || reason === 'cancelled') {
      q.status = reason;
      errorCode = reason;
    } else if (reason) {
      errorCode = 'upstream_timeout';
      errorDetail = reason;
    } else if (!errorCode && !doneEv) {
      // The stream ended without a terminal event: treat as an interrupted answer.
      errorCode = 'upstream_error';
      errorDetail = 'stream ended without response.completed';
    } else if (!errorCode && q.answer.trim() === '') {
      errorCode = 'upstream_error';
      errorDetail = `empty answer (${doneEv?.status ?? 'unknown'} ${doneEv?.reason ?? ''})`;
    }

    if (errorCode) {
      if (q.status === 'streaming') q.status = 'error';
      q.errorCode = errorCode;
      await w.send({ type: 'answer.error', ...ids, code: errorCode, message: ERROR_MESSAGES[errorCode], retryable: isRetryable(errorCode) });
    } else {
      q.status = 'done';
      q.truncated = doneEv?.status === 'incomplete' || hasUnclosedFence(q.answer);
      state.addTurn(session, q.question, q.answer);
      await w.send({ type: 'answer.done', ...ids, truncated: q.truncated, replayed: false, model: q.model });
    }
    finished = true;
    w.end();

    const totalMs = Math.round(performance.now() - t0);
    const usage = doneEv?.usage;
    // Timing-only log line: no question or answer text.
    log.info(
      {
        ...ids,
        mode: r.mode,
        model: q.model,
        status: q.status,
        errorCode,
        headersMs,
        firstDeltaMs,
        totalMs,
        chars: q.answer.length,
        maxOutputTokens,
        inputTokens: usage?.input_tokens,
        cachedTokens: usage?.input_tokens_details?.cached_tokens,
        outputTokens: usage?.output_tokens,
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
      },
      'answer finished',
    );
    if (errorDetail && q.status === 'error') log.warn({ ...ids, errorCode, detail: errorDetail }, 'answer upstream error');

    const metrics: Record<string, number> = { serverTotalMs: totalMs };
    if (headersMs !== null) metrics.serverOpenAiHeadersMs = headersMs;
    if (firstDeltaMs !== null) metrics.serverFirstDeltaMs = firstDeltaMs;
    state.addTiming({ at: Date.now(), source: 'server', mode: r.mode, model: q.model, inputMode: r.inputMode, metrics });
  }
}
