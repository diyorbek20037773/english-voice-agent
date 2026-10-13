import type { AnswerErrorCode } from '../../../shared/stream-events.ts';

/**
 * Maps an OpenAI error (HTTP status + code/type/message) to a stable code. Raw
 * upstream text is only logged server-side (shortened); the browser receives
 * the fixed English message for the code.
 */
export function classifyOpenAiError(status: number | undefined, code: string | undefined, message: string | undefined): AnswerErrorCode {
  const c = (code ?? '').toLowerCase();
  const m = (message ?? '').toLowerCase();
  if (c === 'insufficient_quota' || /exceeded your current quota|billing|credit balance/.test(m)) return 'insufficient_credit';
  if (c === 'model_not_found' || /model .{0,80}does not exist|do(es)? not have access to (the )?model/.test(m)) return 'model_unavailable';
  if (status === 401 || c === 'invalid_api_key' || /incorrect api key|invalid api key/.test(m)) return 'openai_auth';
  if (status === 429 || c === 'rate_limit_exceeded' || /rate limit/.test(m)) return 'rate_limited';
  if (/timed? ?out|timeout|etimedout/.test(`${c} ${m}`)) return 'upstream_timeout';
  if (status === 400) return 'bad_upstream_request';
  return 'upstream_error';
}

export function isRetryable(code: AnswerErrorCode): boolean {
  return code === 'rate_limited' || code === 'upstream_timeout' || code === 'upstream_error' || code === 'internal';
}

/** Shortens upstream text for logs and strips anything that looks like a key. */
export function scrub(text: unknown, max = 300): string {
  return String(text ?? '')
    .replace(/(sk|ek)[-_][A-Za-z0-9_*.-]{6,}/g, '[redacted]')
    .slice(0, max);
}
