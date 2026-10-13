import { randomUUID } from 'node:crypto';
import type { AnswerErrorCode, AnswerMode } from '../../shared/stream-events.ts';
import { startOfDayIso } from './lib/time.ts';

// In-memory state for the single-replica MVP (no database). Everything here is
// bounded and disappears on restart; no audio is ever held.

export interface QuestionRecord {
  questionId: string;
  requestId: string;
  status: 'streaming' | 'done' | 'error' | 'superseded' | 'cancelled';
  question: string;
  answer: string;
  truncated: boolean;
  errorCode: AnswerErrorCode | null;
  mode: AnswerMode;
  model: string;
}

export interface PracticeSession {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  /** Completed turns, oldest first (follow-up context). */
  turns: { question: string; answer: string }[];
  /** Dedup window: (session, questionId) → record. Insertion-ordered for eviction. */
  questions: Map<string, QuestionRecord>;
  active: { questionId: string; abort: (reason: 'superseded') => void } | null;
}

export interface TimingSample {
  at: number;
  source: 'client' | 'server';
  mode: string | null;
  model: string | null;
  inputMode: string | null;
  metrics: Record<string, number>;
}

export const STATE_LIMITS = {
  sessions: 50,
  sessionTtlMs: 12 * 3_600_000,
  turnsKept: 6,
  questionsPerSession: 300,
  timingSamples: 2000,
};

export class MemoryState {
  private readonly sessions = new Map<string, PracticeSession>();
  private daily = { day: '', count: 0 };
  readonly timings: TimingSample[] = [];
  readonly startedAt = new Date().toISOString();

  constructor(private readonly timeZone: string) {}

  createSession(now = Date.now()): PracticeSession {
    this.prune(now);
    const s: PracticeSession = { id: randomUUID(), createdAt: now, lastUsedAt: now, turns: [], questions: new Map(), active: null };
    this.sessions.set(s.id, s);
    while (this.sessions.size > STATE_LIMITS.sessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]!;
      this.sessions.delete(oldest.id);
    }
    return s;
  }

  getSession(id: string, now = Date.now()): PracticeSession | null {
    const s = this.sessions.get(id);
    if (!s || now - s.lastUsedAt > STATE_LIMITS.sessionTtlMs) return null;
    s.lastUsedAt = now;
    return s;
  }

  recordQuestion(s: PracticeSession, q: QuestionRecord): void {
    s.questions.set(q.questionId, q);
    while (s.questions.size > STATE_LIMITS.questionsPerSession) s.questions.delete(s.questions.keys().next().value!);
  }

  addTurn(s: PracticeSession, question: string, answer: string): void {
    s.turns.push({ question, answer });
    if (s.turns.length > STATE_LIMITS.turnsKept) s.turns.splice(0, s.turns.length - STATE_LIMITS.turnsKept);
  }

  /** Answers started today (local time zone). */
  answersToday(now = new Date()): number {
    const day = startOfDayIso(this.timeZone, now);
    if (this.daily.day !== day) this.daily = { day, count: 0 };
    return this.daily.count;
  }

  countAnswer(now = new Date()): void {
    this.answersToday(now);
    this.daily.count++;
  }

  addTiming(t: TimingSample): void {
    this.timings.push(t);
    if (this.timings.length > STATE_LIMITS.timingSamples) this.timings.splice(0, this.timings.length - STATE_LIMITS.timingSamples);
  }

  prune(now = Date.now()): void {
    for (const [id, s] of this.sessions) if (now - s.lastUsedAt > STATE_LIMITS.sessionTtlMs && !s.active) this.sessions.delete(id);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}
