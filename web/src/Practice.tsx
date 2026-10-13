import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api/client.ts';
import { streamAnswer } from './api/answer-stream.ts';
import { AnswerCard, type AnswerItem } from './components/AnswerCard.tsx';
import { SettingsPanel } from './components/Settings.tsx';
import { RealtimeTranscriber, VOICE_ERROR_MESSAGES, type TurnTimings, type VoiceState } from './voice/transcriber.ts';
import type { TurnResult } from './voice/turns.ts';
import { assessQuestion, joinTranscript } from './voice/question.ts';
import type { PracticeSessionResponse, RealtimeSessionResponse } from '../../shared/api-types.ts';
import type { AnswerMode } from '../../shared/stream-events.ts';

type InputMode = 'manual' | 'auto';
type Banner = { kind: 'error' | 'info'; text: string } | null;

/** Auto mode: submit a held fragment anyway after this much extra silence. */
const FRAGMENT_GRACE_MS = 2500;
/** Stop listening after this long without speech, to protect the API budget. */
const IDLE_STOP_MS = 5 * 60_000;

function loadPref<T extends string | number>(key: string, parse: (v: string) => T | null, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return (v !== null ? parse(v) : null) ?? fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable (private mode) */
  }
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export function Practice({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [live, setLive] = useState<{ text: string; final: boolean }[]>([]);
  const [held, setHeld] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>(() => loadPref('eva.inputMode', (v) => (v === 'auto' || v === 'manual' ? v : null), 'manual'));
  const [answerMode, setAnswerMode] = useState<AnswerMode>(() =>
    loadPref('eva.answerMode', (v) => (v === 'quick' || v === 'detailed' ? v : null), 'quick'),
  );
  const [silenceMs, setSilenceMs] = useState<number>(() =>
    loadPref('eva.silenceMs', (v) => (Number(v) >= 300 && Number(v) <= 3000 ? Number(v) : null), 800),
  );
  const [typed, setTyped] = useState('');
  const [answers, setAnswers] = useState<AnswerItem[]>([]);
  const [banner, setBanner] = useState<Banner>(null);
  const [showSettings, setShowSettings] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const transcriberRef = useRef<RealtimeTranscriber | null>(null);
  const currentRef = useRef<{ questionId: string; abort: AbortController } | null>(null);
  const answerModeRef = useRef(answerMode);
  answerModeRef.current = answerMode;
  const heldRef = useRef({ text: '', turn: null as TurnTimings | null });
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpeechAt = useRef(Date.now());

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionRef.current) return sessionRef.current;
    const s = await api<PracticeSessionResponse>('POST', '/practice-sessions', {});
    sessionRef.current = s.id;
    return s.id;
  }, []);

  useEffect(() => {
    void ensureSession().catch((err) => {
      if (err instanceof ApiError && err.status === 401) onLoggedOut();
    });
  }, [ensureSession, onLoggedOut]);

  const patchAnswer = useCallback((questionId: string, patch: Partial<AnswerItem> | ((a: AnswerItem) => Partial<AnswerItem>)) => {
    setAnswers((list) => list.map((a) => (a.questionId === questionId ? { ...a, ...(typeof patch === 'function' ? patch(a) : patch) } : a)));
  }, []);

  const handleAuthLoss = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        transcriberRef.current?.stop();
        onLoggedOut();
        return true;
      }
      return false;
    },
    [onLoggedOut],
  );

  const ask = useCallback(
    async (opts: { question: string; inputMode: 'voice' | 'typed'; kind?: 'question' | 'continue'; continueOf?: string; turn?: TurnTimings | null }) => {
      const question = opts.question.trim();
      if (!question) return;
      const mode = answerModeRef.current;
      const questionId = newId();

      // At most one active answer: a newer question replaces the current one.
      const prev = currentRef.current;
      if (prev) {
        prev.abort.abort();
        patchAnswer(prev.questionId, (a) => (a.status === 'waiting' || a.status === 'streaming' ? { status: 'superseded' } : {}));
      }
      const abort = new AbortController();
      currentRef.current = { questionId, abort };
      setAnswers((list) => [
        { questionId, question: question.replace(/^Continue: /, ''), mode, kind: opts.kind ?? 'question', status: 'waiting', text: '', truncated: false, replayed: false },
        ...list,
      ]);

      const requestAt = performance.now();
      let firstTextAt: number | null = null;
      let doneAt: number | null = null;
      let model: string | undefined;
      let practiceSessionId = '';
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          practiceSessionId = await ensureSession();
          try {
            await streamAnswer(
              { practiceSessionId, questionId, question, mode, kind: opts.kind ?? 'question', continueOf: opts.continueOf, inputMode: opts.inputMode },
              abort.signal,
              (ev) => {
                if (currentRef.current?.questionId !== questionId && ev.type === 'answer.delta') return; // stale
                if (ev.type === 'answer.delta') {
                  // First text is rendered in the same React update (within one frame). Not measured with
                  // requestAnimationFrame: browsers pause it in background tabs, which skews timings.
                  const first = firstTextAt === null;
                  if (first) firstTextAt = performance.now();
                  patchAnswer(questionId, (a) => ({
                    status: 'streaming',
                    text: a.text + ev.delta,
                    ...(first && { firstTextMs: Math.round(firstTextAt! - requestAt) }),
                  }));
                } else if (ev.type === 'answer.done') {
                  doneAt = performance.now();
                  model = ev.model;
                  patchAnswer(questionId, { status: 'done', truncated: ev.truncated, replayed: ev.replayed, model: ev.model, totalMs: Math.round(doneAt - requestAt) });
                } else {
                  patchAnswer(questionId, { status: ev.code === 'superseded' ? 'superseded' : 'error', error: ev.message, retryable: ev.retryable });
                }
              },
            );
            break;
          } catch (err) {
            // The server restarted and forgot the in-memory session: start a new one once.
            if (err instanceof ApiError && err.code === 'session_not_found' && attempt === 0) {
              sessionRef.current = null;
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        if (handleAuthLoss(err)) return;
        if (err instanceof ApiError && err.code === 'duplicate_in_progress') return;
        const message = err instanceof ApiError ? err.message : 'The answer failed.';
        patchAnswer(questionId, (a) => (a.status === 'superseded' ? {} : { status: 'error', error: message, retryable: true }));
      } finally {
        if (currentRef.current?.questionId === questionId) currentRef.current = null;
      }

      // Timing-only report (no text).
      if (doneAt !== null && firstTextAt !== null && firstTextAt > 0) {
        const t = opts.turn;
        const metrics: Record<string, number> = { answerRequestToFirstTextMs: firstTextAt - requestAt, fullAnswerMs: (doneAt as number) - requestAt };
        if (t) {
          if (t.speechStartAt !== null && t.firstPartialAt !== null && t.firstPartialAt >= t.speechStartAt) metrics.firstPartialMs = t.firstPartialAt - t.speechStartAt;
          metrics.endOfSpeechToFinalMs = t.finalAt - t.endOfSpeechAt;
          metrics.endOfSpeechToFirstAnswerMs = firstTextAt - t.endOfSpeechAt;
        }
        void api('POST', '/timings', { practiceSessionId, questionId, mode, model, inputMode: opts.inputMode, metrics }).catch(() => {});
      }
    },
    [ensureSession, handleAuthLoss, patchAnswer],
  );

  const clearHeld = () => {
    if (graceTimer.current) clearTimeout(graceTimer.current);
    graceTimer.current = null;
    heldRef.current = { text: '', turn: null };
    setHeld('');
  };

  const submitHeld = useCallback(() => {
    const { text, turn } = heldRef.current;
    clearHeld();
    if (text) void ask({ question: text, inputMode: 'voice', turn });
  }, [ask]);

  /** Handles a finished voice turn. `force` (manual Answer) submits even an incomplete question. */
  const handleTurn = useCallback(
    (result: TurnResult, timings: TurnTimings | null, force: boolean) => {
      if (result.status === 'final') {
        setBanner(null);
        const combined = joinTranscript(heldRef.current.text, result.text);
        const turn = timings && heldRef.current.turn ? { ...timings, speechStartAt: heldRef.current.turn.speechStartAt } : timings;
        const verdict = assessQuestion(combined);
        if (force || verdict === 'complete') {
          clearHeld();
          void ask({ question: combined, inputMode: 'voice', turn });
          return;
        }
        // Auto mode: hold an obvious fragment and join it with the next part of the speech.
        heldRef.current = { text: combined, turn };
        setHeld(combined);
        if (graceTimer.current) clearTimeout(graceTimer.current);
        if (verdict === 'fragment') graceTimer.current = setTimeout(submitHeld, FRAGMENT_GRACE_MS);
      } else if (result.status === 'timeout') {
        setTyped(joinTranscript(heldRef.current.text, result.text));
        clearHeld();
        setBanner({ kind: 'info', text: 'The final transcript did not arrive in time. Check the text in the question box and press Ask.' });
      } else if (result.status === 'empty') {
        if (force && heldRef.current.text) return submitHeld();
        if (force) setBanner({ kind: 'info', text: 'No speech was captured. Speak, then press Answer — or type your question.' });
      }
    },
    [ask, submitHeld],
  );
  const handleTurnRef = useRef(handleTurn);
  handleTurnRef.current = handleTurn;

  const getTranscriber = useCallback((): RealtimeTranscriber => {
    if (transcriberRef.current) return transcriberRef.current;
    const t = new RealtimeTranscriber(
      () => api<RealtimeSessionResponse>('POST', '/realtime/session', {}),
      {
        onState: setVoiceState,
        onLiveText: setLive,
        onSpeaking: (s) => {
          setSpeaking(s);
          if (s) {
            lastSpeechAt.current = Date.now();
            // New speech: keep waiting for the rest of a held fragment.
            if (graceTimer.current) clearTimeout(graceTimer.current);
            graceTimer.current = null;
          }
        },
        onLevel: setLevel,
        onError: (code, detail) => {
          const base = VOICE_ERROR_MESSAGES[code];
          setBanner({ kind: 'error', text: code === 'token_failed' && detail ? `${base} ${detail}` : base });
        },
        onAutoTurn: (result, timings) => handleTurnRef.current(result, timings, false),
      },
      { mode: inputMode, silenceMs },
    );
    transcriberRef.current = t;
    return t;
  }, [inputMode, silenceMs]);

  useEffect(() => transcriberRef.current?.setMode(inputMode), [inputMode]);
  useEffect(() => transcriberRef.current?.setSilenceMs(silenceMs), [silenceMs]);

  // iOS can suspend the microphone in the background; check when we come back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') transcriberRef.current?.checkHealth();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const voiceActive = voiceState !== 'idle' && voiceState !== 'error';

  // Budget guard: stop listening after 5 minutes without speech.
  useEffect(() => {
    if (!voiceActive || voiceState === 'paused') return;
    lastSpeechAt.current = Date.now();
    const id = setInterval(() => {
      if (Date.now() - lastSpeechAt.current > IDLE_STOP_MS) {
        transcriberRef.current?.stop();
        setLive([]);
        setBanner({ kind: 'info', text: 'Listening stopped after 5 minutes without speech, to save API cost. Press Start to continue.' });
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [voiceActive, voiceState]);

  // Release the microphone when leaving the page.
  useEffect(() => () => transcriberRef.current?.stop(), []);

  const answering = answers.some((a) => a.status === 'waiting' || a.status === 'streaming');
  const liveText = live.map((i) => i.text).join(' ').trim();

  const onStart = () => {
    setBanner(null);
    void getTranscriber().start();
  };
  const onPause = () => {
    const t = transcriberRef.current;
    if (!t) return;
    if (voiceState === 'paused') t.resume();
    else t.pause();
  };
  const onAnswer = async () => {
    const t = transcriberRef.current;
    if (t && voiceActive) {
      const { result, timings } = await t.commitTurn();
      if (result.status === 'empty' && !heldRef.current.text && typed.trim()) {
        void ask({ question: typed, inputMode: 'typed' });
        setTyped('');
        return;
      }
      handleTurn(result, timings, true);
    } else if (typed.trim()) {
      void ask({ question: typed, inputMode: 'typed' });
      setTyped('');
    } else {
      setBanner({ kind: 'info', text: 'Press Start Listening to speak, or type a question.' });
    }
  };
  const onStop = () => {
    transcriberRef.current?.stop();
    setLive([]);
    setSpeaking(false);
    clearHeld();
  };
  const onClear = () => {
    transcriberRef.current?.clearTurn();
    currentRef.current?.abort.abort();
    currentRef.current = null;
    clearHeld();
    setTyped('');
    setLive([]);
    setAnswers([]);
    setBanner(null);
  };
  const onEditTranscript = () => {
    const text = joinTranscript(held, liveText);
    if (!text) return;
    setTyped((prev) => joinTranscript(prev, text));
    clearHeld();
    transcriberRef.current?.clearTurn();
  };
  const onAskTyped = () => {
    if (!typed.trim()) return;
    void ask({ question: typed, inputMode: 'typed' });
    setTyped('');
  };
  const onLogout = async () => {
    transcriberRef.current?.stop();
    await api('POST', '/logout', {}).catch(() => {});
    onLoggedOut();
  };

  const status: { label: string; tone: string } =
    voiceState === 'error'
      ? { label: 'Error', tone: 'error' }
      : voiceState === 'transcribing'
        ? { label: 'Transcribing…', tone: 'busy' }
        : answering
          ? { label: 'Answering…', tone: 'busy' }
          : voiceState === 'connecting'
            ? { label: 'Connecting…', tone: 'busy' }
            : voiceState === 'paused'
              ? { label: 'Paused', tone: 'paused' }
              : voiceState === 'listening'
                ? { label: 'Listening', tone: 'live' }
                : { label: 'Ready', tone: 'idle' };

  return (
    <div className="app">
      <header className="topbar">
        <h1>Voice Practice</h1>
        {voiceActive && (
          <span className={`mic-badge ${voiceState === 'paused' ? 'paused' : 'on'}`} aria-label={voiceState === 'paused' ? 'Microphone paused' : 'Microphone on'}>
            <span className="mic-dot" />
            {voiceState === 'paused' ? 'Mic paused' : 'Mic on'}
          </span>
        )}
        <span className={`status-pill tone-${status.tone}`} role="status" aria-live="polite">
          <span className="dot" />
          {status.label}
        </span>
        <button type="button" className="btn small ghost" onClick={() => setShowSettings(true)} aria-label="Settings">
          ⚙
        </button>
      </header>

      {banner && (
        <div className={`banner ${banner.kind}`} role={banner.kind === 'error' ? 'alert' : 'status'}>
          <p>{banner.text}</p>
          <button type="button" className="btn small ghost" onClick={() => setBanner(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <section className="toggles" aria-label="Modes">
        <div className="segmented" role="group" aria-label="Input mode">
          {(['manual', 'auto'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={inputMode === m ? 'on' : ''}
              aria-pressed={inputMode === m}
              onClick={() => {
                setInputMode(m);
                savePref('eva.inputMode', m);
                if (m === 'manual') clearHeld();
              }}
            >
              {m === 'manual' ? 'Manual' : 'Auto'}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Answer length">
          {(['quick', 'detailed'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={answerMode === m ? 'on' : ''}
              aria-pressed={answerMode === m}
              onClick={() => {
                setAnswerMode(m);
                savePref('eva.answerMode', m);
              }}
            >
              {m === 'quick' ? 'Quick' : 'Detailed'}
            </button>
          ))}
        </div>
      </section>

      <section className="controls" aria-label="Controls">
        {!voiceActive ? (
          <button type="button" className="btn primary big" onClick={onStart}>
            Start Listening
          </button>
        ) : (
          <button type="button" className="btn big" onClick={onPause} disabled={voiceState === 'connecting'}>
            {voiceState === 'paused' ? 'Resume' : 'Pause'}
          </button>
        )}
        <button type="button" className="btn accent big" onClick={() => void onAnswer()} disabled={voiceState === 'transcribing' || voiceState === 'connecting'}>
          Answer
        </button>
        <button type="button" className="btn big" onClick={onStop} disabled={!voiceActive}>
          Stop
        </button>
        <button type="button" className="btn big" onClick={onClear}>
          Clear
        </button>
      </section>
      {voiceActive && (
        <div className="level" aria-hidden="true">
          <div className={`level-bar ${speaking ? 'speaking' : ''}`} style={{ transform: `scaleX(${voiceState === 'paused' ? 0 : level})` }} />
        </div>
      )}
      {inputMode === 'auto' && voiceActive && (
        <p className="hint">Auto: answers after {silenceMs} ms of silence once the question sounds complete. Answer works any time.</p>
      )}

      <section className="panel live" aria-label="Live transcript">
        <div className="panel-head">
          <h2>Live transcript</h2>
          {(liveText || held) && (
            <button type="button" className="btn small ghost" onClick={onEditTranscript}>
              Edit
            </button>
          )}
        </div>
        <p className="live-text" aria-live="polite">
          {held && <span className="final held">{held} </span>}
          {live.length === 0 && !held ? (
            <span className="muted">{voiceActive ? 'Speak now…' : 'Press Start Listening and speak in English.'}</span>
          ) : (
            live.map((i, idx) => (
              <span key={idx} className={i.final ? 'final' : 'partial'}>
                {i.text}{' '}
              </span>
            ))
          )}
        </p>
        {held && <p className="muted small">Waiting for the rest of the question… (press Answer to send now)</p>}
      </section>

      <section className="panel typed" aria-label="Typed question">
        <label htmlFor="typed-question">
          <h2>Question</h2>
        </label>
        <textarea id="typed-question" rows={3} maxLength={2000} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type or edit a question…" />
        <div className="row end">
          <button type="button" className="btn primary" onClick={onAskTyped} disabled={!typed.trim()}>
            Ask
          </button>
        </div>
      </section>

      <section className="answers" aria-label="Answers">
        <h2 className="sr-only">Answers</h2>
        {answers.length === 0 && <p className="muted center">Answers appear here.</p>}
        {answers.map((a, idx) => (
          <AnswerCard
            key={a.questionId}
            item={a}
            latest={idx === 0}
            onContinue={(item) => void ask({ question: `Continue: ${item.question}`, inputMode: 'typed', kind: 'continue', continueOf: item.questionId })}
            onRetry={(item) => void ask({ question: item.question, inputMode: 'typed' })}
          />
        ))}
      </section>

      {showSettings && (
        <SettingsPanel
          silenceMs={silenceMs}
          onSilenceMs={(ms) => {
            setSilenceMs(ms);
            savePref('eva.silenceMs', ms);
          }}
          onClose={() => setShowSettings(false)}
          onLogout={() => void onLogout()}
        />
      )}
    </div>
  );
}
