import { usePanelOpen } from '../lib/panelState';

// The one collapsible section in this app.
//
// George, 2026-08-12: "can you make all the tabs on the financials page and individual
// tenant pages collapsible like we have for rent escalations? but the one for rent
// escalations is a bit unnoticeable."
//
// ⚠ THIS EXISTS BECAUSE THE PATTERN WAS ALREADY COPIED FOUR TIMES — the lease page's
// escalations block, TenantStatement, and twice on HistoryPage — and the four had already
// drifted into two different default states and two different hit-target sizes. Wrapping a
// dozen more sections by hand would have made that a permanent feature of the codebase.
// One implementation, so "how a section folds" is decided once (CLAUDE.md §3).
//
// THE CONVENTION IT ENFORCES: a folded panel still states what it holds. `summary` is not
// decoration — it is what stops folding from costing the landlord the one figure he'd have
// opened the section for. Pass it.
//
//  id           stable key it is remembered under, e.g. 'fin.expenses'. NEVER derive it
//               from the title: titles carry the fiscal year, and the fold would forget
//               itself every January. Omit it for a section that shouldn't be remembered.
//  title        the heading
//  hint         the muted line shown while OPEN (today's description)
//  summary      the muted line shown while FOLDED (what the section holds)
//  actions      buttons that sit OUTSIDE the toggle — a <button> inside a <button> is
//               invalid, which is why Expense entry's Import, Roof's "Billed separately"
//               checkbox and the breakdown's Export button are passed here
//  stack        title over note rather than beside it (the cam-block shape)
//  bare         render no .panel box — for a section that already draws its own card
//  headClass    the head's class when it isn't a .panel-head (e.g. 'cam-head')
//  open + onOpenChange  controlled mode. Used by the panels a dashboard alert can point at
//               (?focus=renewal / =insurance), which must be forced open before the page
//               scrolls and flashes them — never scroll-and-flash a panel that's shut.
export default function Panel({
  id,
  title,
  hint = null,
  summary = null,
  actions = null,
  defaultOpen = true,
  stack = false,
  bare = false,
  className = '',
  headClass = 'panel-head',
  panelRef = null,
  open: openProp,
  onOpenChange,
  children,
}) {
  const [ownOpen, setOwnOpen] = usePanelOpen(id, defaultOpen);
  // Controlled whenever the caller supplies both halves. Supplying only `open` would give
  // a lid that can be forced open and never closed again, so it isn't a supported shape.
  const controlled = typeof openProp === 'boolean' && typeof onOpenChange === 'function';
  const open = controlled ? openProp : ownOpen;

  function toggle() {
    const next = !open;
    if (controlled) onOpenChange(next);
    else setOwnOpen(next);
  }

  const note = open ? hint : summary;
  const wrapCls = [bare ? '' : 'panel', className, open ? '' : 'has-fold-shut'].filter(Boolean).join(' ');
  const label = typeof title === 'string' ? title : 'this section';

  return (
    <div className={wrapCls || undefined} ref={panelRef}>
      <div className={`${headClass} panel-head-fold${open ? ' is-open' : ''}`}>
        <button
          type="button"
          className={`panel-toggle${stack ? ' panel-toggle-stack' : ''}`}
          aria-expanded={open}
          onClick={toggle}
          title={open ? `Fold ${label} away` : `Open ${label}`}
        >
          <span className={`panel-caret${open ? ' is-open' : ''}`} aria-hidden="true">▸</span>
          <span className="panel-toggle-text">
            <strong>{title}</strong>
            {note ? <span className="muted panel-note">{note}</span> : null}
          </span>
        </button>
        {actions}
      </div>
      {open && children}
    </div>
  );
}
