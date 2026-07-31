import { fmtDate } from '../lib/format';
import { noticeAnchor, resolveNotice, noticeLeadLabel } from '../lib/renewals';
import { leadAsUnits } from '../lib/notifyPrefs';

// When notice on a renewal option is due — said the way the lease says it.
//
// George, 2026-07-30: "make sure i can click into notice by and change the duration to
// something specific like how many months before".
//
// A lease writes a duration ("180 days prior to expiration", "twelve (12) months prior"),
// so that is what this asks for; the date is derived and shown, never typed. A plain date
// stays available for the cases where a lease genuinely names one, or where the landlord
// simply knows the day.
//
// Presentational and fully controlled: the parent holds the draft and the resolved values
// are recomputed from the CURRENT window on every render. That is what lets the add
// dialog's deadline follow the term while it's being typed, with no effect to keep in
// sync — and it means this one control can serve both the dialog and the inline row on
// the options table without the two drifting apart.
export default function NoticeByField({ win, draft, onChange, autoFocus, defaultDays = null }) {
  const set = (patch) => onChange({ ...draft, ...patch });
  const isDate = draft.mode === 'date';
  const anchor = noticeAnchor(win);
  const { notice_by_date: resolved } = resolveNotice(draft, win);
  // Where the figure in the box came from, when it came from the owner's Settings rather
  // than the lease. Passed only when this option had no deadline of its own, so the line
  // is provenance for what's sitting there — not a standing advert for Settings.
  const fromDefault = leadAsUnits(defaultDays);

  return (
    <div className="notice-by">
      <div className="notice-by-row">
        {isDate ? (
          <input className="text-input" type="date" aria-label="Notice due on" autoFocus={autoFocus}
            value={draft.date || ''} onChange={(e) => set({ date: e.target.value })} />
        ) : (
          <input className="text-input num notice-by-n" type="number" min="1" step="1" placeholder="6"
            aria-label="How far ahead notice is due" autoFocus={autoFocus}
            value={draft.n} onChange={(e) => set({ n: e.target.value })} />
        )}
        <select className="text-input" aria-label="How the notice deadline is stated"
          value={draft.mode} onChange={(e) => set({ mode: e.target.value })}>
          <option value="months">months before</option>
          <option value="days">days before</option>
          <option value="date">on a set date</option>
        </select>
      </div>

      {/* The arithmetic, shown rather than asked for — including WHAT it counts back
          from, which is the part a bare date can never tell you. */}
      {!isDate && (
        <p className="notice-by-read">
          {resolved
            ? <>Due <strong>{fmtDate(resolved)}</strong> — counted back from {fmtDate(anchor)}, when the term this option extends runs out.</>
            : <span className="muted">{draft.n && Number(draft.n) > 0
              ? 'Give the option a term above — the deadline counts back from the end of the period it extends.'
              : 'How long before the option period starts is notice due?'}</span>}
        </p>
      )}

      {fromDefault && (
        <p className="notice-by-default muted">
          Pre-filled from your default of <strong>{noticeLeadLabel(fromDefault.n, fromDefault.unit)}</strong> (Settings
          → Notifications). Change it here for this tenant — it won’t move your default.
        </p>
      )}
    </div>
  );
}
