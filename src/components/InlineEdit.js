import { useState } from 'react';

// Click a table cell, change what it says, press Enter. (George, 2026-08-17: "theres no
// way to edit date paid or the names of the expense components.")
//
// ⚠ WHY THIS IS NOT `EditField`. EditField (./EditField.js) is the same GESTURE — click,
// Enter commits, Esc cancels — but it renders a labelled block for the lease page's field
// grid: its own caption, a 16px value, a pencil, an AI-confidence badge. Dropping that
// into a four-column expense row would drag all of it in. This renders as the cell and
// nothing else. Two click-to-edit controls WILL drift, so the deploy log carries them as a
// pair to converge; today they genuinely answer different questions.
//
// The look is `.notice-cell`'s — the dashed underline that already means "this cell is
// editable" on the renewal options table. One idiom for one affordance, so a landlord who
// has clicked one knows the other is clickable.
//
// Fully uncontrolled while open: the draft lives here and the parent hears one `onCommit`
// with the final value. That is what lets a caller run it through a mutation without
// re-rendering the input under the cursor on every keystroke.
export default function InlineEdit({
  value,
  onCommit,
  display,            // how the committed value reads when not editing (defaults to the value)
  type = 'text',
  placeholder = '＋ set',
  title,
  readOnly = false,
  readOnlyTitle,
  className = '',
  inputClassName = 'cam-input',
  maxLength,
  sub,                // an optional second line under the value, shown only when not editing
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const start = () => { setDraft(value ?? ''); setEditing(true); };
  const commit = () => {
    setEditing(false);
    // Nothing typed that differs → no write. A blur on an untouched cell must not put a
    // row through a mutation, or every stray click writes to the database.
    if (String(draft ?? '') !== String(value ?? '')) onCommit(draft === '' ? null : draft);
  };
  const cancel = () => { setDraft(value ?? ''); setEditing(false); };

  if (readOnly) {
    return (
      <span className={`inline-edit-static ${className}`} title={readOnlyTitle}>
        {display ?? value ?? <span className="muted">—</span>}
      </span>
    );
  }

  if (editing) {
    return (
      <input
        className={`${inputClassName} inline-edit-input`}
        autoFocus
        type={type}
        maxLength={maxLength}
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
      />
    );
  }

  const shown = display ?? (value === '' || value == null ? null : value);
  return (
    <button type="button" className={`inline-edit ${className}`} title={title} onClick={start}>
      <span className="inline-edit-val">{shown ?? <span className="muted">{placeholder}</span>}</span>
      {sub && <span className="inline-edit-sub">{sub}</span>}
    </button>
  );
}
