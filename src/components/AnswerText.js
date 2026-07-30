import { Fragment } from 'react';
import { parseAnswer } from '../lib/answerFormat';

// Renders an AI answer as real typography instead of raw markdown. One component for
// every answer surface — the lease/policy/contract assistant and Ask Amlak — so the
// two can't drift into formatting the same model output differently.
//
// Everything is built from parsed text nodes; there is no dangerouslySetInnerHTML and
// no HTML parsing anywhere, so a model that echoed a tag from a lease can't inject it.

function Spans({ spans }) {
  return (
    <>
      {spans.map((s, i) =>
        s.t === 'b' ? <strong key={i}>{s.v}</strong>
          : s.t === 'code' ? <code key={i}>{s.v}</code>
            : <Fragment key={i}>{s.v}</Fragment>
      )}
    </>
  );
}

export default function AnswerText({ text, className = '' }) {
  const blocks = parseAnswer(text);
  if (!blocks.length) return null;
  return (
    <div className={`ans${className ? ` ${className}` : ''}`}>
      {blocks.map((b, i) => {
        if (b.type === 'h') return <p className="ans-h" key={i}><Spans spans={b.spans} /></p>;
        if (b.type === 'quote') return <blockquote className="ans-q" key={i}><Spans spans={b.spans} /></blockquote>;
        if (b.type === 'ul') return <ul className="ans-list" key={i}>{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</ul>;
        if (b.type === 'ol') return <ol className="ans-list" key={i}>{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</ol>;
        return <p key={i}><Spans spans={b.spans} /></p>;
      })}
    </div>
  );
}
