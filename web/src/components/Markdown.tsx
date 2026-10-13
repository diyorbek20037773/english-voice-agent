import { useMemo, useState } from 'react';
import { parseBlocks, parseInline } from '../lib/markdown.ts';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers without async clipboard permission.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function InlineText({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.type === 'code' ? (
          <code key={i} className="inline-code">
            {part.text}
          </code>
        ) : part.type === 'bold' ? (
          <strong key={i}>{part.text}</strong>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function CodeBlock({ lang, code, closed, streaming }: { lang: string; code: string; closed: boolean; streaming: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <figure className="code-block">
      <figcaption>
        <span>{lang || 'code'}</span>
        <button
          type="button"
          className="copy-btn"
          onClick={async () => {
            if (await copyText(code)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <pre>
        <code>{code}</code>
      </pre>
      {!closed && !streaming && <p className="code-warning">This code block is incomplete.</p>}
    </figure>
  );
}

export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="markdown">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.code} closed={b.closed} streaming={streaming && i === blocks.length - 1} />;
          case 'heading':
            return (
              <p key={i} className={`md-h md-h${b.level}`}>
                <InlineText text={b.text} />
              </p>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <InlineText text={it} />
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return (
              <p key={i}>
                <InlineText text={b.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
