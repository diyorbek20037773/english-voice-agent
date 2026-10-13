import { SseParser } from '../../../shared/sse.ts';

/**
 * Adapter for the OpenAI Responses API streaming body (text/event-stream).
 * Only output text deltas become answer text; reasoning items, tool events and
 * metadata are ignored. Terminal events carry OpenAI's real finish status:
 *   response.completed  → done
 *   response.incomplete → done, truncated (e.g. reason "max_output_tokens")
 *   response.failed / error → error
 */
export type ResponsesEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; status: 'completed' | 'incomplete'; reason: string | null; usage: Usage | null }
  | { kind: 'error'; code: string; message: string };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export class ResponsesStreamAdapter {
  private readonly decoder = new TextDecoder('utf-8');
  private readonly parser = new SseParser();
  ignored = 0;

  push(bytes: Uint8Array): ResponsesEvent[] {
    // stream: true keeps incomplete multi-byte UTF-8 sequences buffered across chunks.
    return this.handle(this.parser.push(this.decoder.decode(bytes, { stream: true })));
  }

  end(): ResponsesEvent[] {
    // A final blank line flushes a trailing event that lacked its terminator.
    return this.handle(this.parser.push(this.decoder.decode() + '\n\n'));
  }

  private handle(messages: { event: string; data: string }[]): ResponsesEvent[] {
    const out: ResponsesEvent[] = [];
    for (const m of messages) {
      if (m.data === '[DONE]') continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(m.data) as Record<string, unknown>;
      } catch {
        this.ignored++;
        continue;
      }
      const type = (typeof ev.type === 'string' ? ev.type : m.event) as string;
      const response = (ev.response ?? {}) as { incomplete_details?: { reason?: string }; error?: { code?: string; message?: string }; usage?: Usage };
      switch (type) {
        case 'response.output_text.delta':
          if (typeof ev.delta === 'string' && ev.delta) out.push({ kind: 'delta', text: ev.delta });
          break;
        case 'response.completed':
          out.push({ kind: 'done', status: 'completed', reason: null, usage: response.usage ?? null });
          break;
        case 'response.incomplete':
          out.push({ kind: 'done', status: 'incomplete', reason: response.incomplete_details?.reason ?? null, usage: response.usage ?? null });
          break;
        case 'response.failed':
          out.push({ kind: 'error', code: response.error?.code ?? 'response_failed', message: response.error?.message ?? 'Response failed' });
          break;
        case 'error': {
          const e = (ev.error ?? ev) as { code?: string; message?: string; type?: string };
          out.push({ kind: 'error', code: e.code ?? e.type ?? 'stream_error', message: e.message ?? 'Stream error' });
          break;
        }
        default:
          break;
      }
    }
    return out;
  }
}
