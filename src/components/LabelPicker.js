import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * A typeahead that stays a text box.
 *
 * George, 2026-08-18: *"the mechanism for choosing a CAM item from the drop down list is
 * really bad. i clicked in and it just popped up a really generic looking list that stuck to
 * the page and moved up and down with it."* That was a native `<datalist>` — browser chrome,
 * unstyleable, positioned by the browser rather than by us, which is why it drifted with the
 * page instead of staying on the field.
 *
 * ⚠ FREE TEXT IS THE POINT, NOT A FALLBACK. The offered list is derived from what the
 * landlord has already used (`bucketLabels` in `CamSection`), never a fixed table, so a name
 * nobody has typed before must remain typeable. Selecting only ever fills the box — it is a
 * shortcut for typing, so nothing downstream can tell the two apart, and `categoryFor` reads
 * the same string either way.
 *
 * ⚠ ONE IMPLEMENTATION ON PURPOSE (CLAUDE.md §3). The moment a second surface wants to offer
 * remembered labels it imports this, rather than growing another datalist — two typeaheads
 * drift into two keyboard behaviours and two ideas of what "no match" means.
 */
export default function LabelPicker({
  value,
  onChange,
  options = [],
  placeholder,
  className = 'cam-input',
  ariaLabel,
  id = 'label-picker',
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef(null);

  // Filter on what's typed. An exact match still lists — the landlord may be checking the
  // spelling of a bucket they already have rather than making a new one.
  const shown = useMemo(() => {
    const q = String(value || '').trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => String(o.label).toLowerCase().includes(q));
  }, [options, value]);

  // Reset the highlight whenever the list changes underneath it, so Enter can never pick a
  // row the user is no longer looking at.
  useEffect(() => { setActive(-1); }, [value, open]);

  // Close on any click that isn't ours. Pointerdown rather than click, so the list is gone
  // before a click on something behind it lands.
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const pick = (label) => { onChange(label); setOpen(false); setActive(-1); };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { setOpen(false); setActive(-1); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) { setOpen(true); return; }
      if (!shown.length) return;
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
      return;
    }
    // ⚠ Enter only steals the key when a row is genuinely highlighted. Otherwise it must
    // fall through to the form and submit — the fast path is type-the-name-and-hit-Enter,
    // and a picker that swallowed it would make every new label need a mouse.
    if (e.key === 'Enter' && open && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active].label);
    }
  };

  const listId = `${id}-list`;
  return (
    <div className="lp-wrap" ref={wrapRef}>
      <input
        className={className}
        placeholder={placeholder}
        value={value}
        aria-label={ariaLabel}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && shown.length > 0 && (
        <ul className="lp-list" id={listId} role="listbox">
          {shown.map((o, i) => (
            <li key={o.label} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={`lp-opt${i === active ? ' active' : ''}`}
                // Mousedown, not click: the input's blur would otherwise close the list
                // before the click could land on it.
                onMouseDown={(e) => { e.preventDefault(); pick(o.label); }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="lp-name">{o.label}</span>
                {o.category
                  ? <span className="lp-cat">{o.category}</span>
                  : <span className="lp-cat none">No category yet</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
