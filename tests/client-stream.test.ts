import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamAnswer } from '../web/src/api/answer-stream.ts';
import { encodeSse } from '../shared/sse.ts';
import type { AnswerEvent } from '../shared/stream-events.ts';

function sseResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const body = { practiceSessionId: 's', questionId: 'q_current_01', question: 'Q', mode: 'quick' as const, kind: 'question' as const, inputMode: 'typed' as const };

afterEach(() => vi.unstubAllGlobals());

describe('streamAnswer (browser)', () => {
  it('ignores events for other questions and from a different request id', async () => {
    const ev = (e: AnswerEvent) => encodeSse(e.type, e);
    const text =
      ev({ type: 'answer.delta', requestId: 'r_old', questionId: 'q_previous_1', delta: 'STALE ' }) +
      ev({ type: 'answer.delta', requestId: 'r1', questionId: 'q_current_01', delta: 'Héllo ' }) +
      ev({ type: 'answer.delta', requestId: 'r_other', questionId: 'q_current_01', delta: 'WRONG ' }) +
      ': ping\n\n' +
      ev({ type: 'answer.delta', requestId: 'r1', questionId: 'q_current_01', delta: 'wörld 🚀' }) +
      ev({ type: 'answer.done', requestId: 'r1', questionId: 'q_current_01', truncated: false, replayed: false, model: 'm' });
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(text, 5)));
    const got: AnswerEvent[] = [];
    await streamAnswer(body, new AbortController().signal, (e) => got.push(e));
    expect(got.map((e) => (e.type === 'answer.delta' ? e.delta : e.type))).toEqual(['Héllo ', 'wörld 🚀', 'answer.done']);
  });

  it('throws when the stream ends without a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(encodeSse('answer.delta', { type: 'answer.delta', requestId: 'r', questionId: 'q_current_01', delta: 'x' }))));
    await expect(streamAnswer(body, new AbortController().signal, () => {})).rejects.toThrow(/ended unexpectedly/);
  });

  it('surfaces JSON API errors (e.g. rate limit) with their code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests.' } }), { status: 429, headers: { 'Content-Type': 'application/json' } })),
    );
    await expect(streamAnswer(body, new AbortController().signal, () => {})).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });
});
