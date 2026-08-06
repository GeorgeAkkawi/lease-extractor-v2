import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCustomCategories, createCustomCategory } from '../lib/api';
import { EXPENSE_CATEGORIES } from '../lib/expenseCategories';

// The one control that picks a tax category — and the one that can MINT one (0099).
//
// Written once and used by every surface that asks the question (the CAM bucket chip, the
// statement review's new-bucket row, an entity cost) for the reason CLAUDE.md §3 gives about
// twins: three copies of a dropdown drift, and here the drift would be silent — one screen
// offering the landlord's own categories and another not, over the same stored column.
//
// ⚠ WHAT A CUSTOM CATEGORY IS, because the grouping below is the honest version of it.
// EXPENSE_CATEGORIES is the union of Form 8825 and Schedule E — real lines on real forms —
// and you cannot invent one. Both forms END with a write-in line ("Other (list)") that asks
// you to itemize your own descriptions, and that is what a custom category is: it files
// under Other and supplies that line's text. So the two optgroups are not decoration; they
// tell the landlord which of these the IRS prints and which are their own words.
export default function TaxCategorySelect({
  value,
  onChange,
  allowEmpty = true,
  emptyLabel = 'Not categorized',
  autoFocus = false,
  onBlur,
  className = 'text-input',
  style,
  title,
}) {
  const qc = useQueryClient();
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState('');

  const { data: customs = [] } = useQuery({
    queryKey: ['customCategories'],
    queryFn: listCustomCategories,
  });

  const create = useMutation({
    mutationFn: (label) => createCustomCategory(label),
    onSuccess: (row) => {
      setNaming(false);
      setDraft('');
      qc.invalidateQueries({ queryKey: ['customCategories'] });
      // Select it immediately. Making someone name a category and then hunt for it in the
      // list they just changed is the kind of half-finished flow that makes people stop
      // categorizing at all.
      onChange(row.key);
    },
  });

  if (naming) {
    return (
      <span className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className={className}
          style={{ maxWidth: 190, ...style }}
          autoFocus
          maxLength={60}
          placeholder="Name this category"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) create.mutate(draft);
            if (e.key === 'Escape') { setNaming(false); setDraft(''); }
          }}
        />
        <button type="button" className="btn-sm" disabled={!draft.trim() || create.isPending} onClick={() => create.mutate(draft)}>
          {create.isPending ? 'Saving…' : 'Create'}
        </button>
        <button type="button" className="ghost btn-sm" onClick={() => { setNaming(false); setDraft(''); }}>Cancel</button>
        {create.isError && (
          <span className="note-msg danger" style={{ fontSize: 11 }}>{create.error?.message || 'That category could not be created.'}</span>
        )}
        <span className="muted" style={{ fontSize: 11, flexBasis: '100%' }}>
          It files under <strong>Other</strong> on Form 8825 / Schedule E and prints this name on that
          line’s write-in list — which is exactly what the form asks for.
        </span>
      </span>
    );
  }

  return (
    <select
      className={className}
      style={style}
      autoFocus={autoFocus}
      onBlur={onBlur}
      value={value || ''}
      title={title || 'Which line of your tax return this rolls up to. Reporting only — it never changes what a tenant is billed.'}
      onChange={(e) => {
        if (e.target.value === '__new__') { setNaming(true); return; }
        onChange(e.target.value);
      }}
    >
      {allowEmpty && <option value="">{emptyLabel}</option>}
      <optgroup label="Lines on the return">
        {EXPENSE_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </optgroup>
      {customs.length > 0 && (
        <optgroup label="Your categories (file under Other)">
          {customs.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </optgroup>
      )}
      <option value="__new__">＋ New category…</option>
    </select>
  );
}
