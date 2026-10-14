import { SseParser } from '../../../shared/sse.ts';
import { ANSWER_EVENT_TYPES, type AnswerEvent, type AnswerKind, type AnswerMode } from '../../../shared/stream-events.ts';
import { ApiError, NETWORK_ERROR_MESSAGE } from './client.ts';

export interface AnswerRequestBody {
  practiceSessionId: string;
  questionId: string;
  question: string;
  mode: AnswerMode;
  kind: AnswerKind;
  continueOf?: string;
  inputMode: 'voice' | 'typed';
  image?: string;
}

/**
 * POSTs a question and feeds normalized answer events to `onEvent`. Events for
 * any other questionId, or a different requestId than the first one seen, are
 * dropped so a stale stream can never write into the wrong answer.
 */
export async function streamAnswer(body: AnswerRequestBody, signal: AbortSignal, onEvent: (e: AnswerEvent) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch('/api/answer', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal.aborted) return;
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, data?.error?.code ?? `http_${res.status}`, data?.error?.message ?? `Request failed (HTTP ${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let requestId: string | null = null;
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
        if (!(ANSWER_EVENT_TYPES as readonly string[]).includes(msg.event)) continue;
        let ev: AnswerEvent;
        try {
          ev = JSON.parse(msg.data) as AnswerEvent;
        } catch {
          continue;
        }
        if (ev.questionId !== body.questionId) continue;
        requestId ??= ev.requestId;
        if (ev.requestId !== requestId) continue;
        if (ev.type !== 'answer.delta') finished = true;
        onEvent(ev);
      }
    }
  } catch (err) {
    if (signal.aborted) return;
    throw new ApiError(0, 'network', 'The connection dropped while the answer was streaming.');
  }
  if (!finished && !signal.aborted) {
    throw new ApiError(0, 'network', 'The answer stream ended unexpectedly.');
  }
}
