import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A hover card — the Ledger's answer to George (2026-08-17): *"we need to implement hover
// technology on those and convey good information that makes sense without having to write
// it out"*. Three printed lines under a tenant's name and a third line inside a month box
// were the alternative, and they made the row tall and the grid reflow.
//
// ⚠ WHY IT IS A PORTAL AND NOT CSS. The obvious build is .corp-flyout's: an absolutely
// positioned panel inside the anchor, revealed on :hover. It cannot work here. The Ledger
// table lives inside `.table-wrap`, which is `overflow-x:auto` — and a box with overflow
// on ONE axis computes `auto` on the other, so an absolutely positioned descendant is
// CLIPPED by the scroller on both. (App.css:305 records the sibling of this bug: a hidden
// flyout that still extended a scroll region.) So the card renders through a portal at
// `position: fixed`, measured from the anchor's own rect.
//
// Usage — Tip renders the anchor itself, so a call site stays one element:
//
//   <Tip as="button" className="rr-cell paid" onClick={…} content={<MonthTip …/>}>✓</Tip>
//
// Only the hovered anchor mounts a card, so a 12 × N grid holds no hidden DOM. There is
// deliberately NO provider: the tests that read these cards mount the page, not a tree of
// contexts, and a card that needs wiring at the root is a card someone forgets to wire.

const GAP = 8;
const EDGE = 8;

export default function Tip({ as: As = 'span', content, children, ...rest }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => { if (content) setOpen(true); }, [content]);
  const hide = useCallback(() => setOpen(false), []);

  // A card pinned to a rect goes stale the moment anything moves under it, and the Ledger
  // sits in a horizontal scroller — so scrolling closes it rather than leaving it floating
  // beside the wrong box.
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <As
        {...rest}
        ref={ref}
        onMouseEnter={(e) => { show(); rest.onMouseEnter?.(e); }}
        onMouseLeave={(e) => { hide(); rest.onMouseLeave?.(e); }}
        onFocus={(e) => { show(); rest.onFocus?.(e); }}
        onBlur={(e) => { hide(); rest.onBlur?.(e); }}
      >
        {children}
      </As>
      {open && content && <TipCard anchor={ref}>{content}</TipCard>}
    </>
  );
}

function TipCard({ anchor, children }) {
  const card = useRef(null);
  // Placed after mount, because the flip decision needs the card's real height. Hidden
  // until then — a card that paints at 0,0 for one frame reads as a flicker in the corner.
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect?.();
    const c = card.current?.getBoundingClientRect?.();
    if (!a || !c) return;
    const vw = window.innerWidth || 1024;
    const vh = window.innerHeight || 768;
    const below = a.bottom + GAP;
    const above = a.top - GAP - c.height;
    // Below by default; above when there isn't room and there is room up there.
    const top = below + c.height > vh - EDGE && above > EDGE ? above : below;
    const left = Math.max(EDGE, Math.min(a.left, vw - c.width - EDGE));
    setPos({ top, left });
  }, [anchor]);

  return createPortal(
    <div
      ref={card}
      className="tipcard"
      role="tooltip"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {children}
    </div>,
    document.body,
  );
}

// The card's own furniture, so every Ledger card lays out the same way rather than each
// call site inventing a row.
export const TipTitle = ({ children }) => <p className="tip-title">{children}</p>;
export const TipNote = ({ children }) => <p className="tip-note">{children}</p>;
export const TipRule = () => <div className="tip-rule" />;

export function TipRow({ label, value, tone, sub = false, strong = false }) {
  return (
    <div className={`tip-row${sub ? ' sub' : ''}${strong ? ' strong' : ''}`}>
      <span>{label}</span>
      <b className={tone ? `tip-${tone}` : undefined}>{value}</b>
    </div>
  );
}

// A line the card ends on: what a click will do. Kept apart from TipNote so the instruction
// always reads the same and can never be mistaken for part of the figures above it.
export function TipAction({ children }) {
  return <p className="tip-action">{children}</p>;
}
