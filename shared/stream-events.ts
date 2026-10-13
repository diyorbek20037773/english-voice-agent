// Browser-facing answer stream contract. The backend normalizes OpenAI's
// Responses API stream into exactly these three event types.

export type AnswerMode = 'quick' | 'detailed';
export type AnswerKind = 'question' | 'continue';

export type AnswerErrorCode =
  | 'insufficient_credit'
  | 'rate_limited'
  | 'model_unavailable'
  | 'openai_auth'
  | 'bad_upstream_request'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'superseded'
  | 'cancelled'
  | 'daily_limit'
  | 'internal';

export interface AnswerDeltaEvent {
  type: 'answer.delta';
  requestId: string;
  questionId: string;
  delta: string;
}

export interface AnswerDoneEvent {
  type: 'answer.done';
  requestId: string;
  questionId: string;
  /** OpenAI reported the response as incomplete (e.g. output budget reached), or a code block is unclosed. */
  truncated: boolean;
  /** True when this answer was replayed from memory (duplicate submission), not generated again. */
  replayed: boolean;
  model: string;
}

export interface AnswerErrorEvent {
  type: 'answer.error';
  requestId: string;
  questionId: string;
  code: AnswerErrorCode;
  message: string;
  retryable: boolean;
}

export type AnswerEvent = AnswerDeltaEvent | AnswerDoneEvent | AnswerErrorEvent;

export const ANSWER_EVENT_TYPES = ['answer.delta', 'answer.done', 'answer.error'] as const;

export const ERROR_MESSAGES: Record<AnswerErrorCode, string> = {
  insufficient_credit:
    'Your OpenAI account has insufficient credit or quota. Add credit in the OpenAI billing dashboard, then try again.',
  rate_limited: 'OpenAI is rate limiting requests right now. Wait a few seconds and try again.',
  model_unavailable: 'The configured model is not available to your OpenAI project. Change OPENAI_ANSWER_MODEL on the server.',
  openai_auth: 'The server’s OpenAI API key was rejected. Update OPENAI_API_KEY on the server.',
  bad_upstream_request: 'OpenAI rejected the request settings. Check the model and reasoning settings on the server.',
  upstream_timeout: 'The answer took too long. Try again, or use Quick mode.',
  upstream_error: 'The answer service had a problem. Try again in a moment.',
  superseded: 'A newer question replaced this one.',
  cancelled: 'The answer was cancelled.',
  daily_limit: 'The daily answer limit was reached. It resets at midnight (Asia/Tashkent).',
  internal: 'Something went wrong on the server. Try again.',
};
