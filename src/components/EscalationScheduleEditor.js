import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listEscalations, createEscalation, deleteEscalation, backfillLeaseToToday, resyncLeaseBilling, listAlertStates, upsertAlertState } from '../lib/api';
import { settleBillingChange } from '../lib/invalidate';
import { computeEscalatedRent, priorRentBefore, duplicateRentSteps, rentDupKey } from '../lib/escalations';
import { toAlertStates } from '../lib/alerts';
import { money, fmtDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';
import SelectMenu from './SelectMenu';

// Lists, adds & removes rent escalations. New rent is computed BY CODE (no AI).
// New escalations are 'scheduled' until accepted on the recommendation card.
// Delete is here so an AI mis-read can be corrected (remove the wrong row).
export default function EscalationScheduleEditor({ lease }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const askDeleteEsc = (id) => async () => {
    if (await askConfirm({
      title: 'Delete escalation?',
      message: 'Delete this rent escalation?',
      implications: [
        'Removes this rent step from the lease.',
        'The rent schedule and any billing that used it re-compute.',
        'This can’t be undone.',
      ],
      confirmLabel: 'Delete',
    })) remove.mutate(id);
  };
  const leaseId = lease.id;
  const { data: escalations = [] } = useQuery({ queryKey: ['escalations', leaseId], queryFn: () => listEscalations(leaseId) });

  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [date, setDate] = useState('');
  const [showAll, setShowAll] = useState(false);

  // A long lease can carry 15-20 dated steps; that's a lot of scrolling. When there are
  // many, collapse to the slice that matters NOW — the next few upcoming steps + the few
  // most recent — and let the landlord expand to the full schedule on demand.
  const COLLAPSE_OVER = 8;
  const pad = (n) => String(n).padStart(2, '0');
  const nowD = new Date();
  const todayIso = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;

  // Steps dated on/after the committed term end belong to an un-exercised renewal option:
  // the lease PRINTS the rent for those years, but they only take effect once the option
  // is confirmed. Split them out so they don't read as committed increases — confirming
  // the renewal extends the term and they rejoin the schedule automatically.
  const termEnd = lease?.lease_termination_date || null;
  const allSorted = [...escalations].sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)));
  const sortedEsc = termEnd ? allSorted.filter((e) => String(e.effective_date) < String(termEnd)) : allSorted;
  const pendingRenewalEsc = termEnd ? allSorted.filter((e) => String(e.effective_date) >= String(termEnd)) : [];

  const collapsible = sortedEsc.length > COLLAPSE_OVER && !showAll;
  let visibleEsc = sortedEsc;
  let hiddenFuture = 0;
  let hiddenPast = 0;
  if (collapsible) {
    const future = sortedEsc.filter((e) => String(e.effective_date) > todayIso); // descending: far-future first
    const past = sortedEsc.filter((e) => String(e.effective_date) <= todayIso);  // descending: most-recent first
    const visFuture = future.slice(-3); // the 3 nearest upcoming
    const visPast = past.slice(0, 3);   // the 3 most recent
    visibleEsc = [...visFuture, ...visPast];
    hiddenFuture = future.length - visFuture.length;
    hiddenPast = past.length - visPast.length;
  }

  const propId = lease?.property_id || null;
  const fy = new Date().getFullYear();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['escalations', leaseId] });
    // ⚠ `escalationsByProperty`, not `propertyEscalations` — the second name is a near-miss
    // for a key nothing reads, so this line repainted nothing for as long as it has existed.
    qc.invalidateQueries({ queryKey: ['escalationsByProperty'] });
    settleBillingChange(qc, { propertyId: propId, leaseId, year: fy });
  };

  // Adding or removing a step can change the rent in effect TODAY — re-resolve the
  // lease's current base rent so the header, financials, and this table always agree
  // (a past-dated step takes effect immediately instead of waiting for a reload), then
  // carry that new rent through to the year's stored invoice, which does not rebuild
  // itself from the lease the way the breakdown and the Ledger do.
  const remove = useMutation({
    mutationFn: async (id) => {
      await deleteEscalation(id);
      await backfillLeaseToToday(leaseId);
      await resyncLeaseBilling(leaseId, propId, fy);
    },
    onSuccess: refresh,
  });

  // ── Two steps on one date (see duplicateRentSteps) ────────────────────────────────
  // The lookup is the same server-synced key/value the dashboard's dismissals use, on the
  // same query key — normally a cache hit — so "keep both" follows the landlord to another
  // browser instead of living in this one's localStorage.
  const { data: stateRows = [] } = useQuery({ queryKey: ['alertStates'], queryFn: listAlertStates });
  const dupes = duplicateRentSteps(escalations, { leaseId, dismissed: toAlertStates(stateRows).dismissed });
  const dupDates = new Set(dupes.map((d) => d.date));

  const keepBoth = useMutation({
    mutationFn: (d) => upsertAlertState({ alert_key: rentDupKey(leaseId, d), dismissed: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alertStates'] }),
  });
  // Keeping one figure removes the others on that date. It goes through the same
  // backfill + resync the single-step delete does, because dropping a step can change the
  // rent in effect today and the stored invoice does not rebuild itself.
  const resolveDup = useMutation({
    mutationFn: async ({ keep, group }) => {
      for (const r of group.rows) if (r.id !== keep) await deleteEscalation(r.id);
      await backfillLeaseToToday(leaseId);
      await resyncLeaseBilling(leaseId, propId, fy);
    },
    onSuccess: refresh,
  });
  async function askKeep(group, row) {
    const going = group.rows.filter((r) => r.id !== row.id);
    if (await askConfirm({
      title: `Keep ${money(row.new_base_rent)} for ${fmtDate(group.date)}?`,
      message: `${going.length === 1 ? 'The other step' : `The other ${going.length} steps`} on that date ${going.length === 1 ? 'is' : 'are'} removed: ${going.map((r) => money(r.new_base_rent)).join(', ')}.`,
      implications: [
        `${fmtDate(group.date)} is left with a single rent step of ${money(row.new_base_rent)}.`,
        'The rent schedule and any billing that used it re-compute.',
        'This can’t be undone — you’d re-add the step by hand.',
      ],
      confirmLabel: `Keep ${money(row.new_base_rent)}`,
      tone: 'warn',
    })) resolveDup.mutate({ keep: row.id, group });
  }

  const priorRent = priorRentBefore(lease, escalations, date);
  const preview = value !== '' && date
    ? computeEscalatedRent(priorRent, { escalation_type: type, escalation_value: Number(value) })
    : null;

  const add = useMutation({
    mutationFn: async () => {
      await createEscalation({
        lease_id: leaseId,
        effective_date: date,
        escalation_type: type,
        escalation_value: type === 'manual' ? null : Number(value),
        new_base_rent: type === 'manual' ? Number(value) : computeEscalatedRent(priorRent, { escalation_type: type, escalation_value: Number(value) }),
        status: 'scheduled',
      });
      // A step dated today or earlier takes effect now; backfill applies it and updates
      // the lease's base rent (future-dated steps stay scheduled until their date).
      await backfillLeaseToToday(leaseId);
      await resyncLeaseBilling(leaseId, propId, fy);
    },
    onSuccess: () => { setValue(''); setDate(''); refresh(); },
  });

  return (
    <div>
      <MutationError of={[add, remove, resolveDup, keepBoth]} />

      {/* Two rent steps on one day. The lease said it twice and the two readings don't
          quite agree — so say which two figures, say WHY they differ, and offer the three
          answers. "Keep both" is remembered server-side, which is what stops this from
          being a permanent nag (George: "just for the sake of the software not flagging it
          every time"). */}
      {dupes.map((d) => (
        <div className="note-msg warn dup-flag" key={d.date}>
          <p className="dup-flag-line">
            <strong>Two rent steps on {fmtDate(d.date)}</strong> — {d.rows.map((r) => money(r.new_base_rent)).join(' and ')},
            {' '}{money(d.spread)} apart.{' '}
            {d.kind === 'rounding'
              ? <>They are the same rent: both work out to <strong>{money(d.monthly)} a month</strong>. A lease that prints an annual figure <em>and</em> a monthly one usually rounds one of them, and each was read as its own step.</>
              : <>These are genuinely different rents, so one of them is wrong.</>}
            {' '}Which should the schedule keep?
          </p>
          <div className="dup-flag-acts">
            {d.rows.map((r) => (
              <button type="button" className="btn-sm" key={r.id} disabled={resolveDup.isPending}
                onClick={() => askKeep(d, r)}>
                Keep {money(r.new_base_rent)}
              </button>
            ))}
            <button type="button" className="ghost btn-sm" disabled={keepBoth.isPending}
              title="Both steps are meant to be there. Nothing is deleted and this stops being flagged."
              onClick={() => keepBoth.mutate(d.date)}>
              Keep both — stop asking
            </button>
          </div>
        </div>
      ))}

      {sortedEsc.length === 0 ? (
        <p className="empty-line muted">No escalations scheduled.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Effective</th><th>Type</th><th className="num">Value</th><th className="num">New base rent</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {visibleEsc.map((e) => (
                <tr key={e.id}>
                  {/* The flag above names a date; this is that date, on the rows it means. */}
                  <td>{fmtDate(e.effective_date)}{dupDates.has(String(e.effective_date)) && <span className="badge warn dup-badge">duplicate</span>}</td>
                  <td>{e.escalation_type}</td>
                  <td className="num">{e.escalation_type === 'percent' ? `${e.escalation_value}%` : e.escalation_type === 'fixed' ? money(e.escalation_value) : '—'}</td>
                  <td className="num">{money(e.new_base_rent)}</td>
                  <td><span className={`badge ${e.status === 'applied' ? 'good' : 'warn'}`}>{e.status}</span></td>
                  <td className="num">
                    <button
                      type="button"
                      className="icon-btn danger-btn"
                      title="Delete this escalation"
                      disabled={remove.isPending}
                      onClick={askDeleteEsc(e.id)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sortedEsc.length > COLLAPSE_OVER && (
        <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: -6, marginBottom: 16 }}>
          <button type="button" className="ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${sortedEsc.length} steps`}
          </button>
          {collapsible && (hiddenPast > 0 || hiddenFuture > 0) && (
            <span className="muted" style={{ fontSize: 12 }}>
              {[hiddenPast > 0 ? `${hiddenPast} earlier` : null, hiddenFuture > 0 ? `${hiddenFuture} later` : null].filter(Boolean).join(' · ')} step{hiddenPast + hiddenFuture > 1 ? 's' : ''} hidden
            </span>
          )}
        </div>
      )}

      {pendingRenewalEsc.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <p className="note-msg" style={{ background: 'var(--panel-2)', color: 'var(--muted)', marginBottom: 8 }}>
            <strong>Pending renewal</strong> — the lease prints these rents for the option years, but they
            apply <strong>only if the renewal option is exercised</strong>. Confirm the renewal (in Renewal options)
            and they’ll move into the schedule above.
          </p>
          <div className="table-wrap">
            <table style={{ minWidth: 0 }}>
              <thead><tr><th>Effective</th><th>Type</th><th className="num">Value</th><th className="num">New base rent</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {pendingRenewalEsc.map((e) => (
                  <tr key={e.id} style={{ opacity: 0.7 }}>
                    <td>{fmtDate(e.effective_date)}{dupDates.has(String(e.effective_date)) && <span className="badge warn dup-badge">duplicate</span>}</td>
                    <td>{e.escalation_type}</td>
                    <td className="num">{e.escalation_type === 'percent' ? `${e.escalation_value}%` : e.escalation_type === 'fixed' ? money(e.escalation_value) : '—'}</td>
                    <td className="num">{money(e.new_base_rent)}</td>
                    <td><span className="badge info">if renewed</span></td>
                    <td className="num">
                      <button
                        type="button"
                        className="icon-btn danger-btn"
                        title="Delete this escalation"
                        disabled={remove.isPending}
                        onClick={askDeleteEsc(e.id)}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); if (date && value !== '') add.mutate(); }} style={{ alignItems: 'flex-end' }}>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }}>
          <span>Type</span>
          <SelectMenu className="text-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed $ step</option>
            <option value="cpi">CPI — enter resolved %</option>
            <option value="manual">Manual new rent</option>
          </SelectMenu>
        </label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }}>
          <span>{type === 'manual' ? 'New rent' : type === 'fixed' ? '$ amount' : '%'}</span>
          <input className="text-input num" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 170 }}>
          <span>Effective date</span>
          <input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit" disabled={!date || value === '' || add.isPending}>+ Add escalation</button>
        {preview != null && <span className="muted" style={{ alignSelf: 'flex-end' }}>→ {money(priorRent)} to <strong>{money(preview)}</strong></span>}
      </form>
      {type === 'cpi' && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          CPI isn't pulled automatically — enter the <strong>already-resolved</strong> percentage (the CPI adjustment you've
          calculated for this effective date). It's applied just like a percent step.
        </p>
      )}
    </div>
  );
}
