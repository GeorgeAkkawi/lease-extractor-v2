import { useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listRenewals, deleteRenewal, confirmRenewal, declineRenewal, restoreRenewal, markRenewalRenewedHistoric, draftRenewalApproachingEmail } from '../lib/api';
import { money, money0, fmtDate } from '../lib/format';
import { addMonths, optionLapseReason, renewalFirstYearRent, optionWindows, windowLabel } from '../lib/renewals';
import { cmpRenewal } from '../lib/leaseTerm';
import NotificationEmailModal from './NotificationEmailModal';
import RenewalOptionModal from './RenewalOptionModal';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';

// Badge tone + label for an option's lifecycle status. A pending option whose window
// has passed is shown as "Lapsed" (still actionable — the tenant may have renewed and
// we're catching the record up), not hidden. The title says WHICH way it lapsed.
function statusBadge(status, reason) {
  if (status === 'applied') return { cls: 'good', label: 'Applied' };
  if (status === 'declined') return { cls: 'danger', label: 'Declined' };
  if (reason === 'term_ended') return { cls: 'info', label: 'Lapsed', title: 'The term this option would have extended has already ended.' };
  if (reason === 'notice_passed') return { cls: 'info', label: 'Lapsed', title: 'Its notice deadline passed long before the current term ends — this option belongs to an earlier term the lease has since been extended past.' };
  return { cls: 'warn', label: 'Pending' };
}

// Does the option state its own renewal rent? Either a flat new_rent or an annual %.
// When it doesn't, the lease left the rent to be negotiated (e.g. "fair market value",
// "greater of $X or CPI") — the landlord enters the agreed figure at renewal time.
const optionHasRent = (r) => r.new_rent != null || Number(r.annual_escalation_pct) > 0;

// Term shown as "60 mo (5 yr)" when it's a whole number of years, else "18 mo".
const termLabel = (m) => {
  const n = Number(m);
  if (!n) return '—';
  return n % 12 === 0 ? `${n} mo (${n / 12} yr)` : `${n} mo`;
};

// The rent shown for an option, as { main, sub }: an explicit new_rent, else the
// computed first renewal-year rent from the annual % (base × (1+pct%)) with the
// "+X%/yr" on a small sub-line so the numeric column stays clean. When the lease
// states no rent for the option, we say so and prompt for it at renewal. The base is
// the rent projected to the term end (estimateBase) — what a renewal steps up from —
// falling back to today's base rent. `pendingSteps` are the option-period rent steps
// sitting past the committed term end (the muted "pending renewal" group): when this
// option's flat rent OPENS a multi-year climb, show where it steps up to.
function renewalRent(r, base, pendingSteps) {
  if (r.new_rent != null) {
    const main = money0(r.new_rent);
    if (Array.isArray(pendingSteps) && pendingSteps.length >= 2) {
      const first = Number(pendingSteps[0]?.new_base_rent) || 0;
      const startsHere = Math.abs(first - Number(r.new_rent)) <= Math.max(5, Number(r.new_rent) * 0.0025);
      if (startsHere) {
        const top = Math.max(...pendingSteps.map((s) => Number(s.new_base_rent) || 0));
        if (top > Number(r.new_rent)) return { main, sub: `steps to ${money0(top)}` };
      }
    }
    return { main, sub: null };
  }
  const pct = Number(r.annual_escalation_pct) || 0;
  if (pct > 0) {
    const b = Number(base) || 0;
    const firstYr = b > 0 ? Math.round(b * (1 + pct / 100)) : null;
    return firstYr ? { main: `≈ ${money0(firstYr)}`, sub: `+${pct}%/yr` } : { main: `+${pct}%/yr`, sub: null };
  }
  return { main: 'Not listed', sub: 'enter at renewal' };
}

export default function RenewalOptionsEditor({ leaseId, lease, escalations = [], estimateBase }) {
  const base = estimateBase != null ? estimateBase : Number(lease?.base_rent) || 0;
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const { data: renewals = [] } = useQuery({ queryKey: ['renewals', leaseId], queryFn: () => listRenewals(leaseId) });

  // A PENDING option "lapses" either because the term it would have extended has ended,
  // or because its notice window belonged to an earlier term the lease has since been
  // extended past (optionLapseReason, ../lib/renewals — shared with the bell prompt and
  // the nightly cron so all three agree). We STILL list a lapsed option (the tenant may
  // in fact have renewed and we're catching the record up), just badged "Lapsed".
  // Local-date compare avoids a UTC off-by-one. Applied/declined stay a record either way.
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const termEnd = lease?.lease_termination_date || null;
  const lapseReason = (r) => optionLapseReason(r, termEnd, todayIso);
  const lapsedRows = renewals.filter((r) => lapseReason(r));
  // Which explanation the banner leads with — a term that ended reads differently from
  // an option left over from a superseded term.
  const staleNotice = lapsedRows.some((r) => lapseReason(r) === 'notice_passed');
  const termEnded = lapsedRows.some((r) => lapseReason(r) === 'term_ended');

  // Rent steps sitting PAST the committed term end are the option-period "pending renewal"
  // schedule (an option priced year-by-year). Sorted earliest-first, they let an option's
  // flat first-year rent show where it climbs to over the option term.
  const pendingSteps = (escalations || [])
    .filter((e) => e.effective_date && termEnd && String(e.effective_date) > String(termEnd))
    .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));

  // The dates each option covers (George, 2026-07-30: "dated from when they start to
  // when they end"). Chained in the order they'd be exercised, which is why the sort
  // happens here rather than relying on whatever order the query returned.
  const windows = optionWindows([...renewals].sort(cmpRenewal), termEnd);

  // Adding an option opens a dialog — the fields no longer sit permanently under the table.
  const [adding, setAdding] = useState(false);
  // When Renew is clicked on an option with no stated rent, we expand an inline row to
  // collect the agreed new base rent instead of applying blind: { id, value }.
  const [renewEntry, setRenewEntry] = useState(null);
  // "Already renewed" on a lapsed option opens its own row to collect WHEN it happened:
  // { id, value }. The date is the whole point — it's a history entry, not a decision.
  const [histEntry, setHistEntry] = useState(null);
  // A friendly note when a renewal can't be applied yet (e.g. the lease has no term-end
  // date to roll forward from).
  const [notice, setNotice] = useState('');
  const NO_TERM_END = 'Set this lease’s term-end date first — a renewal extends the term from where it ends, so there’s nothing to roll forward without it.';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['renewals', leaseId] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
  };
  // Confirming/declining a renewal changes the lease term + rent, so refresh those too.
  const refreshAll = () => {
    ['renewals', 'alerts', 'lease', 'leases', 'escalations', 'expiredLeases', 'notifications', 'searchIndex']
      .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };
  const remove = useMutation({ mutationFn: (id) => deleteRenewal(id), onSuccess: refresh });
  const confirm = useMutation({
    // acceptDecrease: the dialog below has already shown both figures, so the API's
    // below-current-rent guard doesn't need to stop us a second time.
    mutationFn: ({ id, newRent }) =>
      confirmRenewal(id, new Date(), { ...(newRent != null ? { newRent } : {}), acceptDecrease: true }),
    onSuccess: (res) => {
      if (res?.needsTermEnd) { setNotice(NO_TERM_END); return; }
      setNotice(''); setRenewEntry(null); refreshAll();
    },
  });
  const decline = useMutation({ mutationFn: (id) => declineRenewal(id), onSuccess: refreshAll });
  const restore = useMutation({ mutationFn: (id) => restoreRenewal(id), onSuccess: refreshAll });
  // Records a long-past exercise as history. Writes nothing to the lease, so it doesn't
  // need the billing invalidations the other three carry — but it does clear the bell
  // prompt and log a history event, so refresh those.
  const historic = useMutation({
    mutationFn: ({ id, date }) => markRenewalRenewedHistoric(id, date),
    onSuccess: () => {
      setHistEntry(null);
      ['renewals', 'alerts', 'notifications', 'historyEvents', 'lease'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
  });
  const acting = confirm.isPending || decline.isPending || restore.isPending || historic.isPending;

  // The "are you sure" for applying an option, stating the exact consequences: the new
  // term end, the rent it books and WHEN, why the option looks stale if it does, and —
  // the one that matters — a loud warning when the option's rent is BELOW the rent in
  // effect today. `override` is the figure typed for an option the lease left open.
  // Every figure here comes from the same helpers the API writes with, so the dialog
  // can't promise one thing and book another.
  async function askRenew(r, override = null) {
    const reason = lapseReason(r);
    const cur = Number(lease?.base_rent) || 0;
    const booked = renewalFirstYearRent(r, cur, override);
    const newEnd = addMonths(termEnd, r.term_months || 12);
    // Has the option's window already started? This is what decides whether the API
    // catches the lease up now or books a dated step — same test as rollLeaseIntoRenewal.
    const begun = String(termEnd) <= todayIso;
    const decrease = cur > 0 && booked > 0 && booked < cur - 0.005;

    const implications = [];
    if (reason === 'notice_passed') {
      implications.push(`Notice on this option was due ${fmtDate(r.notice_by_date)} — years before the current term ends ${fmtDate(termEnd)}. It most likely belongs to an earlier term the lease has since been extended past.`);
    } else if (reason === 'term_ended') {
      implications.push(`This term ended ${fmtDate(termEnd)} — applying the option rolls the lease forward from there and archives the prior term.`);
    }
    implications.push(`Term end moves from ${fmtDate(termEnd)} to ${fmtDate(newEnd)}.`);
    implications.push(begun
      ? `Base rent becomes ${money(booked)} now, and the lease start rolls to ${fmtDate(termEnd)}.`
      : `Books a rent step of ${money(booked)} effective ${fmtDate(termEnd)} — today's rent stays ${money(cur)}.`);
    if (decrease) implications.push(`⚠ That is a DECREASE from the current ${money(cur)} — ${money(cur - booked)}/yr less.`);
    implications.push('An applied option can’t be undone from here.');

    // Lead with the period it covers, not just its length — a date range is what the
    // landlord is actually agreeing to, and it's the same window the row shows.
    const covers = windowLabel(windows[r.id]);
    return askConfirm({
      title: decrease ? 'Apply a renewal that LOWERS the rent?' : 'Apply this renewal option?',
      message: `${r.option_label || 'This option'} — ${covers ? `${covers} (${termLabel(r.term_months)})` : termLabel(r.term_months)} at ${money(booked)}/yr.`,
      implications,
      confirmLabel: decrease ? 'Apply anyway' : 'Apply renewal',
      tone: decrease ? 'danger' : 'warn',
    });
  }

  // Renew click: options that state a rent go straight to the dialog; options with no
  // stated rent open the inline entry so the landlord types the agreed figure first.
  async function onRenewClick(r) {
    // A renewal rolls the term forward from the committed end date. Without one, refuse
    // up front (the API guards too) and tell the landlord what to fix.
    if (!termEnd) { setNotice(NO_TERM_END); return; }
    if (!optionHasRent(r)) {
      setRenewEntry({ id: r.id, value: base > 0 ? String(Math.round(base)) : '' });
      return;
    }
    if (await askRenew(r)) confirm.mutate({ id: r.id });
  }

  // "Renewal approaching" heads-up email — a ready-to-send draft the landlord can send any
  // time (no waiting for the bell's due-date prompt). Opens the shared send modal.
  const [emailNotif, setEmailNotif] = useState(null);
  const [emailBusy, setEmailBusy] = useState(null);
  async function emailApproaching(id) {
    setEmailBusy(id);
    try { const n = await draftRenewalApproachingEmail(id); if (n) setEmailNotif(n); }
    finally { setEmailBusy(null); }
  }

  return (
    <div>
      <MutationError of={[remove, confirm, decline, restore]} />
      {notice && (
        <p className="note-msg warn" style={{ marginBottom: 12 }}>{notice}</p>
      )}
      {termEnded && (
        <p className="note-msg warn" style={{ marginBottom: 12 }}>
          This term has ended. If the tenant actually renewed, click <strong>Renew</strong> on the
          option below to roll the lease forward from where the term left off — you can chain them
          (apply Option 1, then Option 2…) until the lease is current again.
        </p>
      )}
      {staleNotice && !termEnded && (
        <p className="note-msg warn" style={{ marginBottom: 12 }}>
          An option below is marked <strong>Lapsed</strong>: its notice deadline passed long before
          this lease’s current term ends, so it belongs to an earlier term the lease has since been
          extended past — usually by an addendum. It’s a leftover record, not a live choice.
          If the tenant <em>did</em> take it back then, record that with <strong>Already renewed</strong> —
          it keeps the history and stops the reminders without touching the term or rent. If they
          never took it, close it with <strong>Not renewing</strong> (undoable) or delete it.
          Applying it would extend the term again and book the rent it quotes.
        </p>
      )}
      {renewals.length === 0 ? (
        <p className="empty-line muted">No renewal options.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Option</th><th>Notice by</th><th title="The period the option covers — it picks up the day after the current term ends, and each option chains from the one before it. For an option not yet exercised this is the period it would cover.">Covers</th><th className="num">New rent</th><th>Status</th><th>Decision</th><th></th></tr></thead>
            <tbody>
              {renewals.map((r) => { const reason = lapseReason(r); const lapsed = !!reason; const badge = statusBadge(r.status, reason); const rent = renewalRent(r, base, r.status === 'pending' ? pendingSteps : null); const covers = windowLabel(windows[r.id]); return (
                <Fragment key={r.id}>
                <tr>
                  <td>{r.option_label || '—'}</td>
                  <td>{r.notice_by_date ? fmtDate(r.notice_by_date) : <span className="muted">—</span>}</td>
                  {/* The period, with the stated length under it. A declined option has
                      no period — nothing will cover it — so it shows the length alone. */}
                  <td className="opt-covers">
                    {covers
                      ? (<><div>{covers}</div><div className="cell-sub">{termLabel(r.term_months)}</div></>)
                      : <span className="muted">{termLabel(r.term_months)}</span>}
                  </td>
                  <td className="num">
                    <div>{rent.main}</div>
                    {rent.sub && <div className="cell-sub">{rent.sub}</div>}
                  </td>
                  <td><span className={`badge ${badge.cls}`} title={badge.title || undefined}>{badge.label}</span></td>
                  {/* Every row's choices land in the same two columns at the same width —
                      the two answers side by side, the follow-up action beneath them —
                      so the column reads as one set of choices instead of a ragged wrap
                      that changes shape per row. */}
                  <td style={{ whiteSpace: 'normal' }}>
                    {r.status === 'pending' ? (
                      <div className="opt-decide">
                        <button type="button" className="btn-sm" disabled={acting}
                          title={lapsed ? 'Apply this lapsed option — you’ll see exactly what it changes first' : 'Tenant is exercising this option — apply it (extends the term + new rent)'}
                          onClick={() => onRenewClick(r)}>
                          Renew
                        </button>
                        <button type="button" className="ghost btn-sm" disabled={acting}
                          title="Tenant is not exercising this option"
                          onClick={async () => {
                            if (await askConfirm({
                              title: 'Mark this option as not being exercised?',
                              message: `${r.option_label || 'This option'} closes — the lease runs out its committed term as it stands.`,
                              implications: [
                                'The term and rent are not changed.',
                                'The option stops appearing as an open decision.',
                                'Undoable — ↩ Undo puts it back to Pending.',
                              ],
                              confirmLabel: 'Not renewing',
                              tone: 'warn',
                            })) decline.mutate(r.id);
                          }}>
                          Not renewing
                        </button>
                        {/* Exactly one follow-up action, spanning both columns. On a lapsed
                            option it's the third answer that option needs: "Renew" would
                            extend the term again and book its old rent, "Not renewing" would
                            be untrue — this records that it WAS exercised, back then, and
                            changes nothing. Otherwise it's the heads-up email. */}
                        {lapsed ? (
                          <button type="button" className="ghost btn-sm opt-wide" disabled={acting}
                            title="The tenant exercised this option years ago — record it as history without changing the term or rent"
                            onClick={() => setHistEntry({ id: r.id, value: r.notice_by_date || lease?.lease_start || todayIso })}>
                            Already renewed
                          </button>
                        ) : (
                          <button type="button" className="ghost btn-sm opt-wide" disabled={emailBusy === r.id}
                            title="Email the tenant that their renewal is coming up (a ready-to-send heads-up)"
                            onClick={() => emailApproaching(r.id)}>
                            {emailBusy === r.id ? '…' : '✉ Email tenant'}
                          </button>
                        )}
                      </div>
                    ) : r.status === 'declined' ? (
                      // The Status column one cell left already reads "Declined" — repeating
                      // it here only pushed the one real action out of alignment.
                      <div className="opt-decide">
                        <button type="button" className="ghost btn-sm" disabled={acting}
                          title="Undo — put this option back to Pending"
                          onClick={() => restore.mutate(r.id)}>
                          ↩ Undo
                        </button>
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>{r.applied_at ? `Applied · ${fmtDate(r.applied_at)}` : (r.notes || '—')}</span>
                    )}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="icon-btn danger-btn"
                      title="Delete this renewal option"
                      disabled={remove.isPending}
                      onClick={async () => {
                        if (await askConfirm({
                          title: 'Delete renewal option?',
                          message: 'Delete this renewal option?',
                          implications: [
                            'Removes the option from this lease.',
                            'If it was already applied, the term and rent it set are NOT reversed.',
                            'This can’t be undone.',
                          ],
                          confirmLabel: 'Delete',
                        })) remove.mutate(r.id);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
                {renewEntry?.id === r.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--gold-soft)' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', padding: '4px 2px' }}>
                        <div className="muted" style={{ fontSize: 12.5, flex: '1 1 220px', minWidth: 200 }}>
                          This option doesn’t state a rent{r.notes ? <> — the lease says: <em>“{r.notes}”</em></> : ''}.
                          {' '}Enter the agreed new base rent to apply it.
                        </div>
                        <label className="form-field" style={{ marginBottom: 0, maxWidth: 170 }}>
                          <span>New base rent ($/yr)</span>
                          <input className="text-input num" type="number" step="any" autoFocus value={renewEntry.value}
                            onChange={(e) => setRenewEntry({ id: r.id, value: e.target.value })} />
                        </label>
                        <button type="button" disabled={acting || renewEntry.value === '' || !(Number(renewEntry.value) > 0)}
                          onClick={async () => {
                            const v = Number(renewEntry.value);
                            if (await askRenew(r, v)) confirm.mutate({ id: r.id, newRent: v });
                          }}>
                          {confirm.isPending ? 'Applying…' : 'Apply renewal'}
                        </button>
                        <button type="button" className="ghost" onClick={() => setRenewEntry(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
                {histEntry?.id === r.id && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--panel-2)' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', padding: '4px 2px' }}>
                        <div className="muted" style={{ fontSize: 12.5, flex: '1 1 240px', minWidth: 220 }}>
                          Records that the tenant <strong>did</strong> exercise this option, on the date below.
                          The lease’s term and rent are left exactly as they are — whatever followed is
                          already on the lease.
                        </div>
                        <label className="form-field" style={{ marginBottom: 0, maxWidth: 180 }}>
                          <span>Renewed on</span>
                          <input className="text-input" type="date" autoFocus value={histEntry.value}
                            onChange={(e) => setHistEntry({ id: r.id, value: e.target.value })} />
                        </label>
                        <button type="button" disabled={acting || !histEntry.value}
                          onClick={async () => {
                            if (await askConfirm({
                              title: 'Record this option as already renewed?',
                              message: `${r.option_label || 'This option'} is marked exercised on ${fmtDate(histEntry.value)} — a history entry, not a change.`,
                              implications: [
                                'The term end and base rent are NOT changed — nothing is re-billed.',
                                'It stops appearing as an open decision, and the reminder about it stops.',
                                'It shows on the property’s History timeline as a renewal on that date.',
                                'Can’t be undone from here (delete the option to remove the record).',
                              ],
                              confirmLabel: 'Record as renewed',
                            })) historic.mutate({ id: r.id, date: histEntry.value });
                          }}>
                          {historic.isPending ? 'Recording…' : 'Record as renewed'}
                        </button>
                        <button type="button" className="ghost" onClick={() => setHistEntry(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      {/* One button, not a permanent strip of six inputs. Everything an option needs —
          including the rent steps inside its own period — is asked in the dialog, where
          there's room to ask it properly (George, 2026-07-30). */}
      <button type="button" onClick={() => setAdding(true)}>+ Add option</button>
      <ul className="muted" style={{ fontSize: 12, marginTop: 10, paddingLeft: 18, lineHeight: 1.6 }}>
        <li><strong>Renew</strong> extends the term + sets the new rent; <strong>Not renewing</strong> closes the option (both undoable).</li>
        <li>On a <strong>Lapsed</strong> option, <strong>Already renewed</strong> records that it was exercised back then — history only, no change to the term or rent.</li>
        <li>An option can carry its own year-by-year rents. They stay hidden until it’s renewed, then become real rent steps.</li>
        <li>If an option’s rent reads <strong>Not listed</strong>, the lease left it to be negotiated — you’ll enter the agreed new base rent when you click <strong>Renew</strong>.</li>
      </ul>

      {adding && (
        <RenewalOptionModal
          leaseId={leaseId}
          renewals={renewals}
          termEnd={termEnd}
          baseRent={base}
          onClose={() => setAdding(false)}
        />
      )}

      {emailNotif && (
        <NotificationEmailModal
          notif={emailNotif}
          onClose={() => setEmailNotif(null)}
          onSent={() => setEmailNotif(null)}
        />
      )}
    </div>
  );
}
