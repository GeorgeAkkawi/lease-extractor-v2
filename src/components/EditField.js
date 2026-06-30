import { useState } from 'react';
import { fmtDate } from '../lib/format';

// Click-to-edit field (design pattern). Commit on Enter/blur, cancel on Esc.
// Shows AI / review-AI confidence badges; editing clears the review state.
export default function EditField({ label, value, onCommit, type = 'text', prefix = '', conf, hint }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const review = conf != null && conf < 0.8;

  function start() {
    setDraft(value ?? '');
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    if (String(draft) !== String(value ?? '')) onCommit(draft === '' ? null : draft);
  }

  return (
    <div className={'field' + (review ? ' field-review' : '')}>
      <span className="field-label">
        {label}
        {conf != null && <ConfBadge conf={conf} />}
      </span>
      {editing ? (
        <input
          className="field-input"
          autoFocus
          type={type}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); }
          }}
        />
      ) : (
        <div className="field-value" onClick={start}>
          {value != null && value !== '' ? (type === 'date' ? fmtDate(value) : `${prefix}${value}`) : <span className="muted">—</span>}
          <span className="edit-pencil">✎</span>
        </div>
      )}
      {hint && <span className="field-hint muted">{hint}</span>}
    </div>
  );
}

function ConfBadge({ conf }) {
  if (conf == null) return null;
  const c = Number(conf);
  return (
    <span className={`badge ${c >= 0.8 ? 'info' : 'warn'}`} title={`AI confidence ${Math.round(c * 100)}%`}>
      {c >= 0.8 ? 'AI' : 'review AI'}
    </span>
  );
}
