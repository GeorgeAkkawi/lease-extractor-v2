import { useState } from 'react';
import { incomeCategoriesInUse, customCategoryKey } from '../lib/otherIncome';
import SelectMenu from './SelectMenu';

// Pick a kind of other income — or name one that doesn't exist yet (George, 2026-08-13:
// "there should be an option in record as to create a category of other income if they want
// to").
//
// ONE component for all three pickers — the Financials hand-entry form, the chip that
// re-files an existing receipt, and the Ledger's "Record as…" on an unplaced line. Three
// hand-rolled copies of a write-in flow is exactly the drift CLAUDE.md §3 is about: they
// would sooner or later disagree about what a valid category name is, and the one that was
// wrong would be storing keys nothing can read back.
//
// The write-in itself is `custom:<slug>` from expenseCategories.js — the same machinery CAM
// buckets and tax categories use, borrowed rather than copied, so a key stays VALID BY SHAPE
// at every call site that has never heard of this landlord's list.
//
// ⚠ Every option here is money the PROPERTY EARNED. One export prints the lot as revenue, so
// a write-in must not become the back door for owner money that `otherIncome.js` explicitly
// refuses a `contribution` category to keep shut — hence the note under the input.
const NEW = '__new__';

export default function IncomeCategorySelect({
  value, onChange, rows = [], disabled = false, autoFocus = false, onBlur,
  className = 'text-input', style, title, placeholder = null,
}) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');
  const options = incomeCategoriesInUse(rows);

  function commit() {
    const key = customCategoryKey(draft);
    setNaming(false);
    setDraft('');
    // An unusable name (blank, or only punctuation) leaves the pick where it was rather
    // than storing a key nothing can label.
    if (key) onChange(key);
  }

  if (naming) {
    return (
      <span className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className={className}
          style={{ maxWidth: 175, ...style }}
          autoFocus
          placeholder="Name the category"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setNaming(false); setDraft(''); }
          }}
        />
        <button type="button" className="secondary btn-sm" disabled={!draft.trim()} onClick={commit}>Use it</button>
        <button type="button" className="ghost btn-sm" onClick={() => { setNaming(false); setDraft(''); }}>Cancel</button>
        <span className="muted" style={{ fontSize: 10.5, width: '100%' }}>
          Income the property earned. Money you put in yourself isn’t income — record that as a transfer.
        </span>
      </span>
    );
  }

  return (
    <SelectMenu
      className={className}
      style={style}
      value={value ?? ''}
      disabled={disabled}
      autoFocus={autoFocus}
      onBlur={onBlur}
      title={title}
      onChange={(e) => {
        if (e.target.value === NEW) setNaming(true);
        else if (e.target.value !== '') onChange(e.target.value);
      }}
    >
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      <option value={NEW}>＋ New category…</option>
    </SelectMenu>
  );
}
