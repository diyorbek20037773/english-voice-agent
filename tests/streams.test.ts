import { describe, expect, it } from 'vitest';
import { SseParser, encodeSse } from '../shared/sse.ts';
import { ResponsesStreamAdapter, type ResponsesEvent } from '../server/src/openai/responses-stream.ts';

const enc = new TextEncoder();

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

const STREAM =
  sse('response.created', { response: { id: 'r1', status: 'in_progress' } }) +
  sse('response.output_item.added', { output_index: 0, item: { type: 'reasoning' } }) +
  sse('response.output_text.delta', { delta: 'Привет — ' }) +
  sse('response.output_text.delta', { delta: 'naïve 🚀 ' }) +
  sse('response.output_text.delta', { delta: '日本語 done.' }) +
  sse('response.completed', { response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } });

function collect(chunks: Uint8Array[]): ResponsesEvent[] {
  const a = new ResponsesStreamAdapter();
  const out: ResponsesEvent[] = [];
  for (const c of chunks) out.push(...a.push(c));
  out.push(...a.end());
  return out;
}

const textOf = (events: ResponsesEvent[]) =>
  events
    .filter((e): e is Extract<ResponsesEvent, { kind: 'delta' }> => e.kind === 'delta')
    .map((e) => e.text)
    .join('');

describe('ResponsesStreamAdapter (OpenAI Responses API SSE)', () => {
  it('parses a whole stream', () => {
    const events = collect([enc.encode(STREAM)]);
    expect(textOf(events)).toBe('Привет — naïve 🚀 日本語 done.');
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'completed' });
  });

  it('handles every possible split point, including inside multi-byte UTF-8 characters', () => {
    const bytes = enc.encode(STREAM);
    for (let i = 1; i < bytes.length; i++) {
      const events = collect([bytes.slice(0, i), bytes.slice(i)]);
      expect(textOf(events)).toBe('Привет — naïve 🚀 日本語 done.');
      expect(events.filter((e) => e.kind === 'done')).toHaveLength(1);
    }
  });

  it('handles one-byte chunks', () => {
    const bytes = enc.encode(STREAM);
    const events = collect([...bytes].map((b) => Uint8Array.of(b)));
    expect(textOf(events)).toBe('Привет — naïve 🚀 日本語 done.');
  });

  it('reports incomplete responses with their reason', () => {
    const events = collect([
      enc.encode(sse('response.output_text.delta', { delta: 'x' }) + sse('response.incomplete', { response: { incomplete_details: { reason: 'max_output_tokens' } } })),
    ]);
    expect(events.at(-1)).toMatchObject({ kind: 'done', status: 'incomplete', reason: 'max_output_tokens' });
  });

  it('turns response.failed and error events into errors', () => {
    expect(collect([enc.encode(sse('response.failed', { response: { error: { code: 'server_error', message: 'boom' } } }))])).toEqual([
      { kind: 'error', code: 'server_error', message: 'boom' },
    ]);
    expect(collect([enc.encode(sse('error', { code: 'rate_limit_exceeded', message: 'slow down' }))])).toEqual([
      { kind: 'error', code: 'rate_limit_exceeded', message: 'slow down' },
    ]);
  });

  it('flushes a final event that lacks its trailing blank line', () => {
    const events = collect([enc.encode(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tail"}`)]);
    expect(textOf(events)).toBe('tail');
  });

  it('ignores malformed data lines without throwing', () => {
    const a = new ResponsesStreamAdapter();
    expect(a.push(enc.encode('data: {not json}\n\n'))).toEqual([]);
    expect(a.ignored).toBe(1);
  });
});

describe('SseParser (browser side of our own stream)', () => {
  it('round-trips encodeSse across arbitrary splits and CRLF', () => {
    const payload = { type: 'answer.delta', delta: 'line1\nline2 “quotes” 🚀' };
    const text = (encodeSse('answer.delta', payload) + ': ping\n\n' + encodeSse('answer.done', { ok: true })).replace(/\n/g, '\r\n');
    for (let i = 1; i < text.length; i++) {
      const p = new SseParser();
      const msgs = [...p.push(text.slice(0, i)), ...p.push(text.slice(i))];
      expect(msgs.map((m) => m.event)).toEqual(['answer.delta', 'answer.done']);
      expect(JSON.parse(msgs[0]!.data)).toEqual(payload);
    }
  });
});
