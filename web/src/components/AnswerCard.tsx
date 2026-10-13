import { Markdown } from './Markdown.tsx';
import type { AnswerMode } from '../../../shared/stream-events.ts';

export interface AnswerItem {
  questionId: string;
  question: string;
  mode: AnswerMode;
  kind: 'question' | 'continue';
  status: 'waiting' | 'streaming' | 'done' | 'error' | 'superseded';
  text: string;
  truncated: boolean;
  replayed: boolean;
  model?: string;
  error?: string;
  retryable?: boolean;
  firstTextMs?: number;
  totalMs?: number;
}

const fmt = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);

export function AnswerCard({
  item,
  latest,
  onContinue,
  onRetry,
}: {
  item: AnswerItem;
  latest: boolean;
  onContinue: (item: AnswerItem) => void;
  onRetry: (item: AnswerItem) => void;
}) {
  const busy = item.status === 'waiting' || item.status === 'streaming';
  return (
    <article className={`answer-card ${latest ? 'latest' : ''} status-${item.status}`} aria-busy={busy}>
      <header>
        <p className="question-text">
          {item.kind === 'continue' ? <em>Continue: </em> : null}
          {item.question}
        </p>
        <div className="badges">
          <span className={`badge mode-${item.mode}`}>{item.mode === 'quick' ? 'Quick' : 'Detailed'}</span>
          {item.model && <span className="badge">{item.model}</span>}
          {item.replayed && <span className="badge">saved</span>}
        </div>
      </header>

      {item.status === 'waiting' && <p className="muted pulse">Waiting for the first words…</p>}
      {item.text && <Markdown text={item.text} streaming={busy} />}

      {item.status === 'superseded' && <p className="muted">Stopped: a newer question replaced this one.</p>}
      {item.status === 'error' && (
        <div className="card-error" role="alert">
          <p>{item.error}</p>
          <button type="button" className="btn small" onClick={() => onRetry(item)}>
            Ask again
          </button>
        </div>
      )}
      {item.status === 'done' && item.truncated && (
        <div className="card-warning">
          <p>This answer may be cut off.</p>
          <button type="button" className="btn small" onClick={() => onContinue(item)}>
            Continue
          </button>
        </div>
      )}
      {(item.firstTextMs !== undefined || item.totalMs !== undefined) && (
        <p className="timing">
          {item.firstTextMs !== undefined && <>First text {fmt(item.firstTextMs)}</>}
          {item.totalMs !== undefined && <> · full answer {fmt(item.totalMs)}</>}
        </p>
      )}
    </article>
  );
}
