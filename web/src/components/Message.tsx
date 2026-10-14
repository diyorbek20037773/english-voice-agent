import { useState } from 'react';
import { Markdown, copyText } from './Markdown.tsx';
import { DEFAULT_IMAGE_NOTE, type AnswerMode } from '../../../shared/stream-events.ts';

export interface AnswerItem {
  questionId: string;
  question: string;
  mode: AnswerMode;
  kind: 'question' | 'continue' | 'image';
  /** Local thumbnail (blob: URL) and the uploaded data for retries; photo tasks only. */
  imageUrl?: string;
  imageData?: string;
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

const secs = (ms?: number) => (ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);

export function UserMessage({ item }: { item: AnswerItem }) {
  return (
    <div className="msg-user">
      <div className="bubble">
        {item.imageUrl && <img className="bubble-img" src={item.imageUrl} alt="Task photo" />}
        {item.kind === 'continue' && <span className="bubble-tag">Continue · </span>}
        {item.kind === 'image' ? <span className={item.question === DEFAULT_IMAGE_NOTE ? 'bubble-tag' : ''}>{item.question}</span> : item.question}
      </div>
    </div>
  );
}

export function AssistantMessage({
  item,
  onContinue,
  onRetry,
}: {
  item: AnswerItem;
  onContinue: (item: AnswerItem) => void;
  onRetry: (item: AnswerItem) => void;
}) {
  const [copied, setCopied] = useState(false);
  const busy = item.status === 'waiting' || item.status === 'streaming';
  return (
    <div className="msg-assistant" aria-busy={busy} aria-live={busy ? 'polite' : undefined}>
      {item.status === 'waiting' && (
        <div className="typing" aria-label="Answering">
          <span />
          <span />
          <span />
        </div>
      )}
      {item.text && <Markdown text={item.text} streaming={busy} />}

      {item.status === 'superseded' && <p className="note">Stopped — a newer question replaced this one.</p>}
      {item.status === 'error' && (
        <div className="note note-error" role="alert">
          <span>⚠ {item.error}</span>
          <button type="button" className="link-btn" onClick={() => onRetry(item)}>
            Ask again
          </button>
        </div>
      )}
      {item.status === 'done' && item.truncated && (
        <div className="note">
          <span>This answer may be cut off.</span>
          <button type="button" className="link-btn" onClick={() => onContinue(item)}>
            Continue
          </button>
        </div>
      )}

      {!busy && item.status !== 'error' && (
        <div className="meta">
          <span>{item.mode === 'quick' ? 'Quick' : 'Detailed'}</span>
          {item.model && <span>{item.model}</span>}
          {item.firstTextMs !== undefined && <span>first text {secs(item.firstTextMs)}</span>}
          {item.totalMs !== undefined && <span>total {secs(item.totalMs)}</span>}
          {item.replayed && <span>saved</span>}
          {item.text && (
            <button
              type="button"
              className="link-btn"
              onClick={async () => {
                if (await copyText(item.text)) {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
