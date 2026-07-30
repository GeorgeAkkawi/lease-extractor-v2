import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createRenewal } from '../lib/api';
import { addMonths, optionWindows, windowLabel } from '../lib/renewals';
import { cmpRenewal } from '../lib/leaseTerm';
import { money0, fmtDate } from '../lib/format';
import { useModalA11y } from './modalA11y';

// Writing a renewal option down, in one place.
//
// George, 2026-07-30: "take out all the boxes for adding an option and only have them
// appear when the add option button is clicked. when that button is clicked you can
// create a popup that has the user answer all those questions and it needs to be a bit
// more in depth like if the rent goes up yearly or within a certain term amount the user
// should have to option to update that like 'add rent escalation as part of this option'
// and that should be hidden but be remembered so that when the renewal is applied the
// escalations save."
//
// The old inline strip put six inputs side by side under the table, permanently, and
// still couldn't express the commonest thing a lease prints: a rent PER YEAR of the
// option period. Two of those inputs ("New rent" and "or +%/yr") were also mutually
// exclusive with no way to tell — filling both was silently meaningless.
//
// So the rent is ONE question with four answers, and only the answer you pick asks
// anything further. Everything else the option needs — how long it runs, when notice is
// due — sits above it, with the period it would cover derived live from the term so you
// can see the years you're writing down before you save them.
const DRAFT = '__draft__';

const RENT_MODES = [
  { key: 'flat', label: 'Flat' },
  { key: 'pct', label: 'Rises yearly' },
  { key: 'steps', label: 'Year by year' },
  { key: 'open', label: 'Not stated' },
];

const blankYears = (n) => Array.from({ length: n }, () => '');

export default function RenewalOptionModal({ leaseId, renewals = [], termEnd, baseRent = 0, onClose }) {
  const modalRef = useModalA11y(onClose);
  const qc = useQueryClient();

  const [form, setForm] = useState({ option_label: '', notice_by_date: '', term_months: '', notes: '' });
  const [mode, setMode] = useState('flat');
  const [flat, setFlat] = useState('');
  const [pct, setPct] = useState('');
  const [years, setYears] = useState(blankYears(5));
  const [fillPct, setFillPct] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const months = Math.trunc(Number(form.term_months) || 0);
  // How many yearly rows the option period has room for. A term that isn't a whole
  // number of years still gets a row per started year (18 months → year 1 + year 2).
  const yearCount = months > 0 ? Math.max(1, Math.ceil(months / 12)) : 0;

  // The period this option WOULD cover, chained after the options already on the lease —
  // the same derivation the table's "Covers" column and the confirm dialog use, so what
  // you agree to here is what the row will read afterwards.
  const win = useMemo(() => {
    if (!termEnd || !months) return null;
    const draft = {
      id: DRAFT,
      status: 'pending',
      option_label: form.option_label,
      notice_by_date: form.notice_by_date || null,
      term_months: months,
    };
    return optionWindows([...renewals, draft].sort(cmpRenewal), termEnd)[DRAFT] || null;
  }, [renewals, termEnd, months, form.option_label, form.notice_by_date]);

  // Each option year's own start date, so a year-by-year rent is entered against the
  // date it takes effect rather than a bare row number.
  const yearStart = (i) => (win?.start ? addMonths(win.start, i * 12) : null);

  const yearRows = years.slice(0, yearCount);
  const filledYears = yearRows
    .map((v, i) => ({ months_from_option_start: i * 12, annual: Number(v) }))
    .filter((r) => r.annual > 0);

  // Fill years 2..N from year 1 at a yearly increase — the shape most leases describe in
  // prose ("increasing three percent each year") but print as a table.
  function fillForward() {
    const p = Number(fillPct);
    const first = Number(yearRows[0]);
    if (!(p > 0) || !(first > 0)) return;
    setYears((prev) => {
      const next = [...prev];
      for (let i = 1; i < yearCount; i++) next[i] = String(Math.round(first * Math.pow(1 + p / 100, i)));
      return next;
    });
  }

  const add = useMutation({
    mutationFn: () =>
      createRenewal({
        lease_id: leaseId,
        option_label: form.option_label.trim() || null,
        notice_by_date: form.notice_by_date || null,
        term_months: months || null,
        notes: form.notes.trim() || null,
        // Exactly one rent shape is written; the others are explicitly nulled so an
        // option can never carry two contradictory answers.
        new_rent: mode === 'flat' ? (Number(flat) > 0 ? Number(flat) : null)
          : mode === 'steps' ? (filledYears[0]?.annual ?? null)
            : null,
        annual_escalation_pct: mode === 'pct' && Number(pct) > 0 ? Number(pct) : null,
        rent_schedule: mode === 'steps' && filledYears.length > 1 ? filledYears : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['renewals', leaseId] });
      qc.invalidateQueries({ queryKey: ['alerts'] });
      onClose();
    },
  });

  const rentReady =
    mode === 'open' ||
    (mode === 'flat' && Number(flat) > 0) ||
    (mode === 'pct' && Number(pct) > 0) ||
    (mode === 'steps' && filledYears.length > 0);
  const canSave = months > 0 && rentReady && !add.isPending;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Add a renewal option"
        tabIndex={-1} style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Add a renewal option</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            An option the lease gives the tenant to extend. Nothing here changes the lease —
            it only takes effect when you mark the option renewed.
          </p>

          <div className="opt-fields">
            <label className="form-field">
              <span>Label</span>
              <input className="text-input" placeholder="Option 1" value={form.option_label} onChange={set('option_label')} autoFocus />
            </label>
            <label className="form-field">
              {/* Kept to one line: at this column width a wrapping label pushes its input
                  a row below its neighbours' (the LeaseForm alignment lesson). */}
              <span>Term (months)</span>
              <input className="text-input num" type="number" min="1" placeholder="60" value={form.term_months} onChange={set('term_months')} />
            </label>
            <label className="form-field">
              <span>Notice due by</span>
              <input className="text-input" type="date" value={form.notice_by_date} onChange={set('notice_by_date')} />
            </label>
          </div>

          {/* The period the option would cover, derived from the term. This is the fact a
              lease never prints and the landlord most needs to see before agreeing. */}
          <p className={`opt-covers-note${win ? '' : ' muted'}`}>
            {win
              ? <>Covers <strong>{windowLabel(win)}</strong>{months % 12 === 0 ? ` · ${months / 12} years` : ` · ${months} months`}</>
              : !termEnd
                ? 'Set this lease’s term-end date to see the period this option would cover.'
                : 'Enter the term to see the period this option would cover.'}
          </p>

          <div className="fin-subhead" style={{ marginTop: 18 }}>Rent at renewal</div>
          <div className="seg" role="group" aria-label="How the option prices its rent" style={{ marginBottom: 12 }}>
            {RENT_MODES.map((m) => (
              <button key={m.key} type="button" className={`seg-btn${mode === m.key ? ' on' : ''}`}
                aria-pressed={mode === m.key} onClick={() => setMode(m.key)}>
                {m.label}
              </button>
            ))}
          </div>

          {mode === 'flat' && (
            <div className="opt-rent-block">
              <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}>
                <span>New base rent ($/yr)</span>
                <input className="text-input num" type="number" step="any" placeholder={baseRent > 0 ? String(Math.round(baseRent)) : ''}
                  value={flat} onChange={(e) => setFlat(e.target.value)} />
              </label>
              <p className="muted opt-rent-hint">One rent for the whole option term.</p>
            </div>
          )}

          {mode === 'pct' && (
            <div className="opt-rent-block">
              <label className="form-field" style={{ marginBottom: 0, maxWidth: 160 }}>
                <span>Increase (% a year)</span>
                <input className="text-input num" type="number" step="any" placeholder="3"
                  value={pct} onChange={(e) => setPct(e.target.value)} />
              </label>
              <p className="muted opt-rent-hint">
                {Number(pct) > 0 && baseRent > 0
                  ? <>Year 1 would be about <strong>{money0(baseRent * (1 + Number(pct) / 100))}</strong>, compounding each year after — priced off the rent in effect when the option is exercised.</>
                  : <>The rent steps up by this much each year of the option, off whatever the rent is when it’s exercised.</>}
              </p>
            </div>
          )}

          {mode === 'steps' && (
            <div className="opt-rent-block">
              {yearCount === 0 ? (
                <p className="muted opt-rent-hint">Enter the option’s term above — that’s what says how many years to price.</p>
              ) : (
                <>
                  <div className="opt-years">
                    {yearRows.map((v, i) => {
                      const start = yearStart(i);
                      return (
                        <label className="opt-year" key={i}>
                          <span className="opt-year-n">Year {i + 1}</span>
                          <span className="opt-year-when">{start ? `from ${fmtDate(start)}` : ' '}</span>
                          <input className="text-input num" type="number" step="any" placeholder="$/yr" value={v}
                            onChange={(e) => setYears((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                        </label>
                      );
                    })}
                  </div>
                  {yearCount > 1 && (
                    <div className="opt-fill">
                      <span className="muted">Or fill the rest from year 1 at</span>
                      <input className="text-input num" type="number" step="any" placeholder="3" aria-label="Yearly increase to fill from year 1"
                        value={fillPct} onChange={(e) => setFillPct(e.target.value)} />
                      <span className="muted">% a year</span>
                      <button type="button" className="ghost btn-sm" onClick={fillForward}
                        disabled={!(Number(fillPct) > 0) || !(Number(yearRows[0]) > 0)}>Fill</button>
                    </div>
                  )}
                  <p className="muted opt-rent-hint">
                    Saved with the option and <strong>hidden</strong> until it’s exercised — nothing appears on
                    the rent schedule for a renewal the tenant hasn’t taken. Marking it renewed writes these as
                    real, dated rent steps.
                  </p>
                </>
              )}
            </div>
          )}

          {mode === 'open' && (
            <div className="opt-rent-block">
              <p className="muted opt-rent-hint" style={{ marginTop: 0 }}>
                The lease leaves the renewal rent to be negotiated — “fair market value”, “greater of $X or CPI”.
                The row will read <strong>Not listed</strong> and ask you for the agreed figure when you renew.
                Put the lease’s own wording in the notes below.
              </p>
            </div>
          )}

          <label className="form-field" style={{ marginTop: 18, marginBottom: 0, maxWidth: '100%' }}>
            <span>Notes — the lease’s own wording</span>
            <input className="text-input" placeholder="e.g. 180 days prior written notice; rent at greater of $41,403 or CPI"
              value={form.notes} onChange={set('notes')} />
          </label>
        </div>

        <div className="modal-foot">
          <div className="modal-actions">
            <span className="muted">
              {add.isError ? 'Could not save this option.'
                : !months ? 'Enter the term — it’s what dates the option.'
                  : !rentReady ? 'Enter the option’s rent, or choose Not stated.'
                    : 'Saved as Pending — it changes nothing until you renew it.'}
            </span>
            <div className="row">
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button onClick={() => add.mutate()} disabled={!canSave}>{add.isPending ? 'Adding…' : 'Add option'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
