import type { AnswerMode } from './stream-events.ts';

export interface MeResponse {
  authenticated: boolean;
}

export interface PracticeSessionResponse {
  id: string;
  createdAt: string;
}

export interface RealtimeSessionResponse {
  clientSecret: string;
  expiresAt: number | null;
  model: string;
  rtcUrl: string;
}

export interface AppConfigResponse {
  modes: Record<AnswerMode, { model: string; reasoningEffort: string | null }>;
  transcriptionModel: string;
  profileConfigured: boolean;
  dailyLimit: number;
  answersToday: number;
}

export interface ModelCheckResponse {
  checked: boolean;
  available: Record<string, boolean>;
  message?: string;
}

export interface ClientTimings {
  firstPartialMs?: number;
  endOfSpeechToFinalMs?: number;
  answerRequestToFirstTextMs?: number;
  endOfSpeechToFirstAnswerMs?: number;
  fullAnswerMs?: number;
}

export interface TimingSummaryRow {
  metric: string;
  count: number;
  p50: number | null;
  p95: number | null;
}

export interface TimingSummaryResponse {
  rows: TimingSummaryRow[];
  /** Timings are kept in memory only (since the last server restart). */
  since: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
