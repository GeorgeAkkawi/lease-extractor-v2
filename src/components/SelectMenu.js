import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A `<select>` that keeps its element and loses its OS menu.
 *
 * George, 2026-08-20: *"I dont like the native design for that drop down selection."* The
 * closed face of every select in this app has been ours since App.css:1755 — the fill, the
 * border, the brass chevron, the focus ring. What was never ours is the list that opens:
 * macOS draws that popup itself and ignores every rule we write, which is the same complaint
 * that retired the `<datalist>` two days earlier (see LabelPicker.js).
 *
 * ⚠ SO THIS REPLACES THE MENU, NOT THE CONTROL. The real `<select>` is still rendered, still
 * focused, still the thing that holds the value — it just has its popup suppressed
 * (`preventDefault` on mousedown, honoured by every browser we target) and ours painted in its
 * place. That is what keeps the trade App.css:1755 records: real keyboard behaviour, real
 * screen-reader behaviour, real form semantics, and every existing test that fires `change` at
 * a select still drives the control it always drove. A from-scratch listbox would have had to
 * re-earn all four.
 *
 * ⚠ FOCUS NEVER LEAVES THE SELECT, and that is load-bearing rather than tidy. `TaxCategorySelect`
 * and `IncomeCategorySelect` are handed an `onBlur` that CLOSES the inline editor around them —
 * so a menu that took focus (a filter box, a focusable list) would close the editor out from
 * under the click that was choosing a value. Options are picked on `mousedown` with the default
 * prevented, LabelPicker's rule for the same reason, so the blur never happens.
 *
 * ⚠ AND THE KEYBOARD IS DELIBERATELY NOT INTERCEPTED while the menu is shut. A keyboard or
 * screen-reader user gets the native control untouched, arrow keys and type-ahead included —
 * the painted list simply follows the value they land on, because it is drawn from the same
 * `value` the select is holding. Only once the menu is open (which takes a pointer) do Escape,
 * Enter and Tab mean "close it".
 *
 * ⚠ IT PORTALS TO <body> AT position:fixed, for the reason Tip.js records: the tables these
 * live in sit inside `.table-wrap`, which is `overflow-x:auto`, and a box with overflow on one
 * axis computes `auto` on the other — an absolutely positioned menu inside the row is clipped
 * on BOTH. Measured from the trigger's own rect, and closed by any scroll rather than left
 * floating beside a control that has moved.
 *
 * Usage is a drop-in rename. The children stay exactly what a select's children were, which is
 * the whole anti-drift argument: the painted rows are READ from the same `<option>` /
 * `<optgroup>` elements the browser is given, so the two lists cannot disagree.
 *
 *   <SelectMenu className="text-input" value={v} onChange={(e) => set(e.target.value)}>
 *     <option value="a">A</option>
 *     <optgroup label="More"><option value="b">B</option></optgroup>
 *   </SelectMenu>
 */

const GAP = 4;
const EDGE = 8;
const MAX_H = 264;
const MAX_W = 360;

// An <option>'s children are not always a string — `{name}{cond ? ` — ${x}` : ''} ({n}%)`
// is an array, and a call site is free to wrap part of it in a <span>. Flatten to the text
// the browser itself would show, so the painted row reads identically to the native one.
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf(node.props.children);
  return '';
}

// Read the SAME children the select is given. `{cond && <optgroup>}` yields `false` and
// `{list.map(...)}` yields an array — Children.forEach flattens the second and isValidElement
// drops the first, so a conditional group costs nothing here.
function readRows(children, rows = [], group = null) {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    // ⚠ DESCEND THROUGH FRAGMENTS. A select whose whole option list is a branch —
    // `{isIn ? (<>…</>) : (<>…</>)}`, which is exactly how StatementReview writes its two —
    // hands this ONE child: a Fragment. Skipping it painted an EMPTY menu over a select
    // that was still perfectly populated, so nothing threw, nothing logged, and the control
    // simply stopped offering anything. Caught in the browser, not by a unit test, because
    // a test harness naturally writes its options out flat.
    if (child.type === Fragment) { readRows(child.props.children, rows, group); return; }
    if (child.type === 'optgroup') {
      readRows(child.props.children, rows, child.props.label ?? null);
      return;
    }
    if (child.type !== 'option') return;
    const label = textOf(child.props.children);
    rows.push({
      // An <option> with no `value` uses its own text as the value — the same rule the DOM
      // applies, and two call sites rely on it.
      value: child.props.value === undefined ? label : String(child.props.value),
      label,
      group,
      disabled: !!child.props.disabled,
    });
  });
  return rows;
}

// Write through the native setter and dispatch a real `change`, rather than hand-rolling a
// `{ target: { value } }`. React's own synthetic event then reaches the call site's onChange
// untouched, so a handler is free to read anything an event carries — and the controlled
// `value` prop still wins on the next render, exactly as it does when a user picks natively.
function commit(el, value) {
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export default function SelectMenu({ children, className, disabled, onBlur, value, ...rest }) {
  const ref = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);

  const rows = readRows(children);
  // The prop when controlled (all of them are), the element otherwise — so a `defaultValue`
  // call site still gets its current row marked.
  const current = value === undefined ? (ref.current?.value ?? '') : String(value ?? '');

  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - EDGE - GAP;
    const above = r.top - EDGE - GAP;
    // Only flip up when down genuinely can't hold a usable list AND up holds more.
    const up = below < 168 && above > below;
    // ⚠ SIZED TO ITS CONTENT, floored at the trigger. A flat minimum looked wrong the moment
    // it met the FY picker — a 180px menu hanging off a 67px control reads as a panel that
    // has come loose rather than that control's own list. The left edge is only corrected
    // once the real width is known, below.
    setPos({
      left: r.left,
      minWidth: r.width,
      maxWidth: Math.min(MAX_W, window.innerWidth - 2 * EDGE),
      up,
      offset: up ? window.innerHeight - r.top + GAP : r.bottom + GAP,
      maxHeight: Math.max(120, Math.min(MAX_H, up ? above : below)),
      placed: false,
    });
  }, [open]);

  // A content-sized menu on a control near the right edge can run off screen, and its width
  // is not knowable until it has rendered — so the overflow is corrected in a second pass,
  // once, guarded by `placed` so the correction cannot re-trigger itself.
  useLayoutEffect(() => {
    if (!open || !pos || pos.placed || !listRef.current) return;
    const w = listRef.current.getBoundingClientRect().width;
    const left = Math.max(EDGE, Math.min(pos.left, window.innerWidth - EDGE - w));
    setPos({ ...pos, left, placed: true });
  }, [open, pos]);

  // ⚠ IT OPENS AT THE TOP OF THE LIST, ON PURPOSE (George, 2026-08-20: *"when i open the
  // drop down it starts at the bottom and i have to scroll up"*). It used to centre itself
  // on the current row, the way macOS positions a native popup — and that is wrong here for
  // a reason specific to this app: an unrecognized money-out line's pick is **Ignore**,
  // which is the LAST option, so the commonest expense row in a statement opened scrolled
  // past all 30 buckets to the bottom. The trigger already prints the current value, so the
  // menu's job is to show the OPTIONS; starting anywhere but the top hides some of them
  // behind a scroll nobody asked for. The ✓ still marks where the current pick sits.

  // A menu pinned to a rect goes stale the moment anything moves under it (Tip.js). Scroll
  // and resize close it rather than leaving it beside the wrong control.
  useEffect(() => {
    if (!open) return undefined;
    // ⚠ THE MENU'S OWN SCROLLING IS NOT THE PAGE MOVING. This listener is in the CAPTURE
    // phase (scroll does not bubble), so it sees every scroll anywhere — including the one
    // the effect below causes by bringing the current row into view. A long list therefore
    // opened and shut itself in the same frame, while a short one that needed no scrolling
    // stayed open: the FY picker looked perfect and the 30-bucket expense picker was
    // unusable. Nothing throws, so only a real browser shows it.
    const close = (e) => { if (listRef.current?.contains(e?.target)) return; setOpen(false); };
    const away = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const pick = (row) => {
    if (row.disabled) return;
    setOpen(false);
    if (ref.current && row.value !== ref.current.value) commit(ref.current, row.value);
  };

  return (
    <>
      <select
        {...rest}
        ref={ref}
        className={className}
        disabled={disabled}
        value={value}
        onMouseDown={(e) => {
          if (disabled || e.button !== 0) return;
          // The whole trick: the OS popup never opens, so ours is the only one.
          e.preventDefault();
          ref.current?.focus();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          // Shut, the native control owns every key — including type-ahead, which is why
          // there is no filter box in the painted list.
          if (!open) return;
          if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
          else if (e.key === 'Enter' || e.key === 'Tab') setOpen(false);
        }}
        onBlur={(e) => { setOpen(false); onBlur?.(e); }}
      >
        {children}
      </select>
      {open && pos && createPortal(
        // aria-hidden on purpose: this is a painted copy of a menu the select already owns,
        // and announcing it twice is worse than not announcing it at all.
        <div
          ref={listRef}
          className={`sm-list${pos.up ? ' up' : ''}`}
          aria-hidden="true"
          style={{
            left: pos.left, minWidth: pos.minWidth, maxWidth: pos.maxWidth, maxHeight: pos.maxHeight,
            ...(pos.up ? { bottom: pos.offset } : { top: pos.offset }),
          }}
        >
          {rows.map((row, i) => (
            <div key={`${row.group || ''}:${row.value}:${i}`}>
              {(i === 0 || rows[i - 1].group !== row.group) && row.group && (
                <div className="sm-group">{row.group}</div>
              )}
              <button
                type="button"
                className={`sm-opt${row.value === current ? ' on' : ''}${row.disabled ? ' off' : ''}`}
                disabled={row.disabled}
                // Mousedown with the default prevented — the select must not blur (see the
                // header note about the inline editors that close on it).
                onMouseDown={(e) => { e.preventDefault(); pick(row); }}
              >
                <span className="sm-mark">{row.value === current ? '✓' : ''}</span>
                <span className="sm-label">{row.label}</span>
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
