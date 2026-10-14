import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { AppConfigResponse, ModelCheckResponse, TimingSummaryResponse } from '../../../shared/api-types.ts';

const METRIC_LABELS: Record<string, string> = {
  firstPartialMs: 'Speech start → first partial transcript',
  endOfSpeechToFinalMs: 'End of speech → final transcript',
  answerRequestToFirstTextMs: 'Answer request → first visible text',
  endOfSpeechToFirstAnswerMs: 'End of speech → first answer text',
  fullAnswerMs: 'Answer request → full answer',
  serverOpenAiHeadersMs: 'Server: OpenAI response headers',
  serverFirstDeltaMs: 'Server: first text from OpenAI',
  serverTotalMs: 'Server: total answer time',
};

const secs = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(2)} s`);

export function SettingsPanel({
  silenceMs,
  onSilenceMs,
  onClose,
  onLogout,
}: {
  silenceMs: number;
  onSilenceMs: (ms: number) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [cfg, setCfg] = useState<AppConfigResponse | null>(null);
  const [timings, setTimings] = useState<TimingSummaryResponse | null>(null);
  const [modelCheck, setModelCheck] = useState<ModelCheckResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<AppConfigResponse>('GET', '/config'), api<TimingSummaryResponse>('GET', '/timings/summary')])
      .then(([c, t]) => {
        setCfg(c);
        setTimings(t);
      })
      .catch((err) => setMessage(err instanceof ApiError ? err.message : 'Could not load settings.'));
  }, []);

  const checkModels = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setModelCheck(await api<ModelCheckResponse>('POST', '/models/check', {}));
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Model check failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <header className="sheet-header">
          <h2>Settings</h2>
          <button type="button" className="btn small" onClick={onClose}>
            Close
          </button>
        </header>
        {message && <p className="sheet-message">{message}</p>}

        <h3>Auto mode</h3>
        <label className="field">
          Silence before answering: {silenceMs} ms
          <input type="range" min={300} max={3000} step={50} value={silenceMs} onChange={(e) => onSilenceMs(Number(e.target.value))} />
        </label>
        <p className="muted small">Saved on this device. Start around 800 ms and tune with your own speech.</p>

        <h3>Models (set on the server)</h3>
        {cfg && (
          <ul className="plain-list">
            <li>
              Quick: <strong>{cfg.modes.quick.model}</strong> · reasoning {cfg.modes.quick.reasoningEffort ?? 'not sent'}
            </li>
            <li>
              Detailed: <strong>{cfg.modes.detailed.model}</strong> · reasoning {cfg.modes.detailed.reasoningEffort ?? 'not sent'}
            </li>
            <li>
              Transcription: <strong>{cfg.transcriptionModel}</strong>
            </li>
            <li>Candidate profile: {cfg.profileConfigured ? 'configured' : 'not set (CANDIDATE_PROFILE)'}</li>
            <li>Target role: {cfg.targetRole || 'not set (TARGET_ROLE)'}</li>
            <li>
              Answers today: {cfg.answersToday} / {cfg.dailyLimit}
            </li>
            <li>
              Voice sessions today: {cfg.voiceSessionsToday} / {cfg.voiceSessionsPerDay}
            </li>
            <li>Access: {cfg.openAccess ? 'open (no unlock screen)' : 'access token'}</li>
          </ul>
        )}
        <div className="row">
          <button type="button" className="btn small" disabled={busy} onClick={() => void checkModels()}>
            Check model access
          </button>
        </div>
        {modelCheck && (
          <ul className="model-check">
            {modelCheck.checked ? (
              Object.entries(modelCheck.available).map(([id, ok]) => (
                <li key={id} className={ok ? 'ok' : 'bad'}>
                  {ok ? 'Available' : 'NOT available'}: {id}
                </li>
              ))
            ) : (
              <li className="bad">{modelCheck.message}</li>
            )}
          </ul>
        )}

        <h3>Latency</h3>
        {timings && (
          <>
            <table className="timings">
              <thead>
                <tr>
                  <th>Measure</th>
                  <th>n</th>
                  <th>p50</th>
                  <th>p95</th>
                </tr>
              </thead>
              <tbody>
                {timings.rows.map((r) => (
                  <tr key={r.metric}>
                    <td>{METRIC_LABELS[r.metric] ?? r.metric}</td>
                    <td>{r.count}</td>
                    <td>{secs(r.p50)}</td>
                    <td>{secs(r.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">Measured on real use since the server started ({new Date(timings.since).toLocaleString()}).</p>
          </>
        )}

        {cfg && !cfg.openAccess && (
          <>
            <h3>Device</h3>
            <div className="row">
              <button type="button" className="btn small" onClick={onLogout}>
                Lock this device
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
