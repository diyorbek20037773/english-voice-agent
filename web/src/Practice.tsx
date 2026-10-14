import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api, ApiError } from './api/client.ts';
import { streamAnswer } from './api/answer-stream.ts';
import { AssistantMessage, UserMessage, type AnswerItem } from './components/Message.tsx';
import { SettingsPanel } from './components/Settings.tsx';
import {
  RealtimeTranscriber,
  VOICE_ERROR_MESSAGES,
  canCaptureLaptopAudio,
  type AudioSource,
  type TurnTimings,
  type VoiceState,
} from './voice/transcriber.ts';
import type { TurnResult } from './voice/turns.ts';
import { assessQuestion, containsQuestion, joinTranscript, trimContext } from './voice/question.ts';
import type { PracticeSessionResponse, RealtimeSessionResponse } from '../../shared/api-types.ts';
import { DEFAULT_IMAGE_NOTE, type AnswerMode } from '../../shared/stream-events.ts';
import { prepareImage } from './lib/image.ts';

type Banner = { kind: 'error' | 'info'; text: string } | null;

/** An unfinished question is answered anyway after this much extra silence. */
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

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={value === o.value ? 'on' : ''} aria-pressed={value === o.value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Practice({ onLoggedOut }: { onLoggedOut: () => void }) {
  const laptopCapable = canCaptureLaptopAudio();
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const [live, setLive] = useState<{ text: string; final: boolean }[]>([]);
  const [held, setHeld] = useState('');
  const [answerMode, setAnswerMode] = useState<AnswerMode>(() =>
    loadPref('eva.answerMode', (v) => (v === 'quick' || v === 'detailed' ? v : null), 'quick'),
  );
  const [source, setSource] = useState<AudioSource>(() =>
    laptopCapable ? loadPref('eva.source', (v) => (v === 'mic' || v === 'laptop' || v === 'both' ? v : null), 'mic') : 'mic',
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
  const stickToBottom = useRef(true);

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

  // Like a chat: follow the newest text while the user is at the bottom; don't yank them back if they scrolled up.
  useEffect(() => {
    const onScroll = () => {
      stickToBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    // Scroll to the true page bottom: the sticky dock sits after the thread, so the newest text lands just above it.
    if (stickToBottom.current && answers.length > 0) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [answers]);

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
    async (opts: {
      question: string;
      inputMode: 'voice' | 'typed';
      kind?: 'question' | 'continue' | 'image';
      continueOf?: string;
      turn?: TurnTimings | null;
      image?: { dataUrl: string; previewUrl?: string };
    }) => {
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
      stickToBottom.current = true;
      setAnswers((list) => [
        ...list,
        {
          questionId,
          question: question.replace(/^Continue: /, ''),
          mode,
          kind: opts.kind ?? 'question',
          status: 'waiting',
          text: '',
          truncated: false,
          replayed: false,
          imageUrl: opts.image?.previewUrl ?? opts.image?.dataUrl,
          imageData: opts.image?.dataUrl,
        },
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
              {
                practiceSessionId,
                questionId,
                question,
                mode,
                kind: opts.kind ?? 'question',
                continueOf: opts.continueOf,
                inputMode: opts.inputMode,
                ...(opts.image && { image: opts.image.dataUrl }),
              },
              abort.signal,
              (ev) => {
                if (currentRef.current?.questionId !== questionId && ev.type === 'answer.delta') return; // stale
                if (ev.type === 'answer.delta') {
                  // First text renders in the same React update (within one frame). Not measured with
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
      if (doneAt !== null && firstTextAt !== null) {
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

  /** An unfinished sentence got no continuation: answer it if it is a question, otherwise keep it as context. */
  const onFragmentGrace = useCallback(() => {
    graceTimer.current = null;
    if (containsQuestion(heldRef.current.text)) submitHeld();
  }, [submitHeld]);

  /**
   * Automatic answering: questions are answered as soon as their final transcript arrives;
   * other complete sentences are kept (trimmed) as context for the next question; fillers are ignored.
   */
  const handleTurn = useCallback(
    (result: TurnResult, timings: TurnTimings | null) => {
      if (result.status === 'final') {
        setBanner(null);
        const prior = heldRef.current;
        const combined = joinTranscript(prior.text, result.text);
        const turn = timings && prior.turn ? { ...timings, speechStartAt: prior.turn.speechStartAt } : timings;
        const verdict = assessQuestion(combined);
        if (verdict === 'question') {
          clearHeld();
          void ask({ question: combined, inputMode: 'voice', turn });
          return;
        }
        if (verdict === 'too_short') return;
        heldRef.current = { text: trimContext(combined), turn: turn ?? prior.turn };
        setHeld(heldRef.current.text);
        if (graceTimer.current) clearTimeout(graceTimer.current);
        graceTimer.current = verdict === 'fragment' ? setTimeout(onFragmentGrace, FRAGMENT_GRACE_MS) : null;
      } else if (result.status === 'timeout') {
        setTyped(joinTranscript(heldRef.current.text, result.text));
        clearHeld();
        setBanner({ kind: 'info', text: 'The final transcript did not arrive in time. Check the text in the message box and press Send.' });
      }
    },
    [ask, onFragmentGrace],
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
        onAutoTurn: (result, timings) => handleTurnRef.current(result, timings),
      },
      { mode: 'auto', silenceMs, source },
    );
    transcriberRef.current = t;
    return t;
  }, [silenceMs, source]);

  useEffect(() => transcriberRef.current?.setSilenceMs(silenceMs), [silenceMs]);
  useEffect(() => transcriberRef.current?.setSource(source), [source]);

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

  // Release the microphone / audio sharing when leaving the page.
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
  const sendTyped = () => {
    if (!typed.trim()) return;
    void ask({ question: typed, inputMode: 'typed' });
    setTyped('');
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
  /** Photo or screenshot of a task → solved right away (a typed note, e.g. "in Java", is sent with it). */
  const sendImage = async (file: Blob) => {
    try {
      setBanner(null);
      const img = await prepareImage(file);
      const note = typed.trim();
      setTyped('');
      void ask({ question: note || DEFAULT_IMAGE_NOTE, inputMode: 'typed', kind: 'image', image: img });
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : 'Could not read the image.' });
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void sendImage(file);
    }
  };
  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop: Enter sends, Shift+Enter adds a line. Touch keyboards: Enter adds a line, use the send button.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault();
      sendTyped();
    }
  };
  const onLogout = async () => {
    transcriberRef.current?.stop();
    await api('POST', '/logout', {}).catch(() => {});
    onLoggedOut();
  };

  const status =
    voiceState === 'error'
      ? 'Error'
      : voiceState === 'transcribing'
        ? 'Transcribing…'
        : answering
          ? 'Answering…'
          : voiceState === 'connecting'
            ? 'Connecting…'
            : voiceState === 'reconnecting'
              ? 'Reconnecting…'
            : voiceState === 'paused'
              ? 'Paused'
              : voiceState === 'listening'
                ? 'Listening'
                : 'Ready';
  const busyStatus = status.endsWith('…');
  const sourceName = source === 'mic' ? 'Mic' : source === 'laptop' ? 'Laptop audio' : 'Laptop + mic';
  const composerRows = Math.min(6, Math.max(1, typed.split('\n').length));

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Voice Practice</span>
        {voiceActive && (
          <span className={`mic-badge ${voiceState === 'paused' ? 'paused' : 'on'}`}>
            <span className="mic-dot" />
            {sourceName} {voiceState === 'paused' ? 'paused' : 'on'}
          </span>
        )}
        <span className={`status ${busyStatus ? 'busy' : ''} ${voiceState === 'listening' && !answering ? 'live' : ''}`} role="status" aria-live="polite">
          <span className="dot" />
          {status}
        </span>
        <button type="button" className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings">
          ⚙
        </button>
      </header>

      <main className="thread" aria-label="Conversation">
        {answers.length === 0 ? (
          <div className="empty">
            <h1>Ready when you are.</h1>
            <p>Press Start — questions are answered automatically. You can also type below.</p>
            {laptopCapable && <p className="small">To use the audio of a Zoom/Meet call on this computer, choose Laptop or Both before Start.</p>}
          </div>
        ) : (
          answers.map((a) => (
            <Fragment key={a.questionId}>
              <UserMessage item={a} />
              <AssistantMessage
                item={a}
                onContinue={(item) => void ask({ question: `Continue: ${item.question}`, inputMode: 'typed', kind: 'continue', continueOf: item.questionId })}
                onRetry={(item) =>
                  void ask(
                    item.kind === 'image' && item.imageData
                      ? { question: item.question, inputMode: 'typed', kind: 'image', image: { dataUrl: item.imageData, previewUrl: item.imageUrl } }
                      : { question: item.question, inputMode: 'typed' },
                  )
                }
              />
            </Fragment>
          ))
        )}
      </main>

      <footer className="dock">
        {banner && (
          <div className={`banner ${banner.kind}`} role={banner.kind === 'error' ? 'alert' : 'status'}>
            <span>{banner.kind === 'error' ? '⚠ ' : ''}{banner.text}</span>
            <button type="button" className="icon-btn small" onClick={() => setBanner(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {(voiceActive || held || liveText) && (
          <div className="live" aria-label="Live transcript">
            <p className="live-text" aria-live="polite">
              {held && <span className="held">{held} </span>}
              {live.length === 0 && !held ? (
                <span className="placeholder">{voiceState === 'paused' ? 'Paused.' : 'Listening… speak in English.'}</span>
              ) : (
                live.map((i, idx) => (
                  <span key={idx} className={i.final ? 'final' : 'partial'}>
                    {i.text}{' '}
                  </span>
                ))
              )}
            </p>
            {(liveText || held) && (
              <button type="button" className="link-btn" onClick={onEditTranscript}>
                Edit
              </button>
            )}
          </div>
        )}
        {held && (
          <p className="hint">
            Kept as context for the next question.{' '}
            <button type="button" className="link-btn small" onClick={submitHeld}>
              Answer this
            </button>
          </p>
        )}
        {voiceActive && (
          <div className="level" aria-hidden="true">
            <div className={`level-bar ${speaking ? 'speaking' : ''}`} style={{ transform: `scaleX(${voiceState === 'paused' ? 0 : level})` }} />
          </div>
        )}

        <div className="toolbar">
          <Segmented
            label="Answer length"
            value={answerMode}
            options={[
              { value: 'quick', label: 'Quick' },
              { value: 'detailed', label: 'Detailed' },
            ]}
            onChange={(m) => {
              setAnswerMode(m);
              savePref('eva.answerMode', m);
            }}
          />
          {laptopCapable && (
            <Segmented
              label="Audio source"
              value={source}
              disabled={voiceActive}
              options={[
                { value: 'mic', label: 'Mic' },
                { value: 'laptop', label: 'Laptop' },
                { value: 'both', label: 'Both' },
              ]}
              onChange={(s) => {
                setSource(s);
                savePref('eva.source', s);
              }}
            />
          )}
        </div>

        <div className="controls">
          {!voiceActive ? (
            <button type="button" className="btn primary" onClick={onStart}>
              Start
            </button>
          ) : (
            <button type="button" className="btn" onClick={onPause} disabled={voiceState === 'connecting'}>
              {voiceState === 'paused' ? 'Resume' : 'Pause'}
            </button>
          )}
          <button type="button" className="btn" onClick={onStop} disabled={!voiceActive}>
            Stop
          </button>
          <button type="button" className="btn" onClick={onClear}>
            Clear
          </button>
        </div>

        <div className="composer">
          <label className="attach" title="Photo or screenshot of a task" aria-label="Solve a task from a photo">
            📷
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void sendImage(file);
              }}
            />
          </label>
          <textarea
            aria-label="Message"
            rows={composerRows}
            maxLength={2000}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onComposerKey}
            onPaste={onPaste}
            placeholder="Type a question, or 📷 a task…"
          />
          <button type="button" className="send" onClick={sendTyped} disabled={!typed.trim()} aria-label="Send">
            ↑
          </button>
        </div>
        {voiceActive && <p className="hint">Answers automatically when a question is heard ({silenceMs} ms pause).</p>}
        {source === 'both' && !voiceActive && <p className="hint">Both: use headphones, otherwise the laptop speakers are heard twice.</p>}
      </footer>

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
