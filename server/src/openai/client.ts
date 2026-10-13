import type { Config } from '../config.ts';

/**
 * Body for POST /v1/realtime/client_secrets: an English transcription-only
 * session. Verified against the live API on 2026-10-13 (HTTP 200, ek_ token).
 * gpt-live-transcribe supports no server VAD, so turn_detection is null and the
 * browser commits turns itself with input_audio_buffer.commit.
 */
export function buildTranscriptionSessionBody(opts: { model: string; keywords: string[]; ttlSeconds: number }) {
  const keywords: string[] = [];
  for (const k of opts.keywords.slice(0, 50)) {
    const t = k.trim();
    // Documented keyword rules: one line each, no "<" or ">".
    if (t && t.length <= 60 && !/[<>\r\n]/.test(t)) keywords.push(t);
  }
  const transcription: Record<string, unknown> = { model: opts.model, languages: ['en'] };
  if (keywords.length > 0) transcription.keywords = keywords;
  return {
    expires_after: { anchor: 'created_at', seconds: Math.min(7200, Math.max(10, Math.floor(opts.ttlSeconds))) },
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription,
          turn_detection: null,
        },
      },
    },
  };
}

export class OpenAiClient {
  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.config.OPENAI_API_KEY}`, ...extra };
  }

  async createClientSecret(body: unknown, timeoutMs = 10_000): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const res = await this.fetchImpl(`${this.config.OPENAI_BASE_URL}/realtime/client_secrets`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, json };
  }

  /** Starts a streaming Responses API request. The caller owns the body. */
  streamResponse(body: unknown, signal: AbortSignal): Promise<Response> {
    return this.fetchImpl(`${this.config.OPENAI_BASE_URL}/responses`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
      signal,
    });
  }

  /** GET /v1/models — free; lists the models this API project can use. */
  async listModels(timeoutMs = 10_000): Promise<{ status: number; ids: string[]; error?: { code?: string; message?: string } }> {
    const res = await this.fetchImpl(`${this.config.OPENAI_BASE_URL}/models`, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    const json = (await res.json().catch(() => null)) as { data?: { id: string }[]; error?: { code?: string; message?: string } } | null;
    return { status: res.status, ids: (json?.data ?? []).map((m) => m.id), error: json?.error };
  }
}
