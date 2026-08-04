import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList,
} from 'recharts';
import { getCorporation, getProperty, listSnapshots, listExpiredLeases, deleteExpiredLease, closeYear, reopenYear, listHistoryEvents, clearPropertyHistory, listLeases, localDateIso } from '../lib/api';
import { buildTenantStories, ledgerEvents } from '../lib/tenantStory';
import { snapshotCollectionSummary } from '../lib/ledger';
import { invokeFunction } from '../lib/supabaseClient';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { money, sf, fmtDate } from '../lib/format';
import LeaseAssistant from '../components/LeaseAssistant';
import { useConfirm } from '../components/ConfirmDialog';

// Friendly labels + badge tones for history_events. Covers both halves — the events that
// belong in a tenant's story and the bookkeeping ones that get their own folded log.
const EVENT_LABEL = {
  tenant_assigned: 'Tenant assigned',
  term_extended: 'Term extended',
  premises_resized: 'Premises re-sized',
  renewal_confirmed: 'Renewal confirmed',
  renewal_declined: 'Renewal declined',
  renewal_reopened: 'Renewal reopened',
  rent_stepped: 'Rent step',
  rent_abated: 'Rent abatement',
  estimate_set: 'CAM & tax estimate set',
  lease_created: 'Lease created',
  insurance_requested: 'Insurance requested',
  // Building-wide, so it carries a property_id and no lease_id — deliberately absent from
  // the tenantStory.js allowlist so it doesn't repeat on every tenant's story.
  announcement_sent: 'Announcement sent',
  signature_sent: 'Sent for signature',
  signature_executed: 'Signed by both parties',
  cam_reconciled: 'CAM & tax reconciled',
  cam_refunded: 'CAM & tax refund paid',
  cam_reconcile_undone: 'CAM & tax reconcile undone',
  cam_refund_reopened: 'CAM & tax refund reopened',
  statement_imported: 'Bank statement imported',
  statement_import_undone: 'Statement import undone',
  // Derived from the lease rows themselves rather than logged — see tenantStory.js.
  moved_in: 'Moved in',
  term_ends: 'Term ends',
  term_ended: 'Term ended',
  left: 'Left',
};
const EVENT_BADGE = {
  tenant_assigned: 'info',
  term_extended: 'good',
  premises_resized: 'info',
  renewal_confirmed: 'good',
  renewal_declined: 'danger',
  renewal_reopened: 'warn',
  rent_abated: 'warn',
  estimate_set: 'info',
  insurance_requested: 'info',
  announcement_sent: 'info',
  signature_sent: 'info',
  // Good, not info: both parties signing is a completed thing, the same way a confirmed
  // renewal is. It does NOT mean the lease changed — that is a separate, later click.
  signature_executed: 'good',
  cam_reconciled: 'info',
  cam_refunded: 'good',
  cam_reconcile_undone: 'warn',
  cam_refund_reopened: 'warn',
  statement_imported: 'info',
  statement_import_undone: 'warn',
  moved_in: 'good',
  term_ends: 'info',
  term_ended: 'danger',
  left: 'info',
};

const num = (v) => (v == null ? 0 : Number(v));
const expenses = (s) => num(s.taxes_total) + num(s.cam_total) + num(s.roof_total);
const noi = (s) => num(s.total_revenue) - expenses(s);
// compact $k label for axis ticks and the value labels drawn on each bar
const kfmt = (v) => (v == null || isNaN(v) ? '' : Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

export default function HistoryPage() {
  const { corpId, propId } = useParams();
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const { year } = useChrome();

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: snaps = [] } = useQuery({ queryKey: ['snapshots', propId], queryFn: () => listSnapshots(propId) });
  const { data: expired = [] } = useQuery({ queryKey: ['expiredLeases', propId], queryFn: () => listExpiredLeases(propId) });
  const { data: events = [] } = useQuery({ queryKey: ['historyEvents', propId], queryFn: () => listHistoryEvents(propId) });
  // The current leases are what turn an empty timeline into a populated record: every
  // tenancy's bookends (moved in / term ends) are derived from these rows, so a card is
  // never blank even before a single history_event has been written.
  const { data: leases = [] } = useQuery({ queryKey: ['leases', propId], queryFn: () => listLeases(propId) });
  usePageChrome([
    { label: 'History', to: '/history' },
    { label: corp?.name || '…', to: `/history/${corpId}` },
    { label: prop?.name || '…' },
  ], true);

  const close = useMutation({ mutationFn: () => closeYear(propId, year), onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshots', propId] }) });
  const reopen = useMutation({ mutationFn: () => reopenYear(propId, year), onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshots', propId] }) });
  const removeExpired = useMutation({ mutationFn: (id) => deleteExpiredLease(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['expiredLeases', propId] }) });
  const clearHistory = useMutation({
    mutationFn: () => clearPropertyHistory(propId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['historyEvents', propId] });
      // "📨 Last requested" on tenants' insurance panels reads the same table.
      qc.invalidateQueries({ queryKey: ['insuranceRequests'] });
    },
  });

  const [narrative, setNarrative] = useState('');
  const [busy, setBusy] = useState(false);
  const [openStory, setOpenStory] = useState(null); // story card key currently unfolded
  const [showLedger, setShowLedger] = useState(false);
  const [openExp, setOpenExp] = useState(null); // archived lease id whose document/assistant is open

  const stories = buildTenantStories({ leases, expired, events, today: localDateIso() });
  const ledger = ledgerEvents(events);

  const sorted = [...snaps].sort((a, b) => a.year - b.year);
  const idx = sorted.findIndex((s) => s.year === year);
  const cur = idx >= 0 ? sorted[idx] : null;
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const closed = !!cur; // this fiscal year already has a saved snapshot

  async function handleClose() {
    if (await askConfirm({
      title: `Close FY ${year}?`,
      message: `Save a permanent snapshot of ${prop?.name || 'this property'}'s financials as they are now?`,
      implications: [
        'Files this year’s revenue, expenses, and per-tenant breakdown under History.',
        'Does NOT change your live financials — you can edit them anytime.',
        'You can reopen the year later to remove the snapshot.',
      ],
      confirmLabel: 'Close year',
      tone: 'default',
    })) close.mutate();
  }
  async function handleReopen() {
    if (await askConfirm({
      title: `Reopen FY ${year}?`,
      message: `Remove the saved ${year} snapshot from History?`,
      implications: [
        `Deletes the ${year} snapshot from History.`,
        `Your live financials for ${year} are not affected.`,
      ],
      confirmLabel: 'Reopen year',
      tone: 'warn',
    })) reopen.mutate();
  }

  const chartData = sorted.map((s) => ({ year: String(s.year), Revenue: num(s.total_revenue), Expenses: expenses(s), NOI: noi(s) }));

  async function generate() {
    setBusy(true);
    try {
      const { narrative } = await invokeFunction('trends-narrative', {
        property_name: prop?.name,
        // Collection figures ride along when the snapshot has them (the fn
        // stringifies the whole series into its prompt — extra keys just work).
        series: sorted.map((s) => {
          const col = snapshotCollectionSummary(s);
          return {
            year: s.year, total_revenue: num(s.total_revenue), taxes_total: num(s.taxes_total),
            cam_total: num(s.cam_total), roof_total: num(s.roof_total), total_expenses: expenses(s), noi: noi(s),
            ...(col ? { rent_collected: col.collected, collection_rate: col.rate != null ? Math.round(col.rate * 100) / 100 : null } : {}),
          };
        }),
      });
      setNarrative(narrative);
    } catch (e) { setNarrative('Could not generate summary: ' + (e.message || e)); } finally { setBusy(false); }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{prop?.name || '…'}</h1>
          <div className="muted">Year-over-year history{prop?.address ? ` · ${prop.address}` : ''}</div>
        </div>
        <div className="head-actions" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          {closed ? (
            <>
              <span className="badge good">✓ FY {year} closed</span>
              <button className="secondary" onClick={handleReopen} disabled={reopen.isPending}>
                {reopen.isPending ? 'Reopening…' : `Reopen FY ${year}`}
              </button>
            </>
          ) : (
            <button onClick={handleClose} disabled={close.isPending}>{close.isPending ? 'Closing…' : `Close FY ${year}`}</button>
          )}
        </div>
      </div>

      <div className="callout" style={{ marginBottom: 16 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          <strong style={{ color: 'var(--ink)' }}>What “Close FY {year}” does:</strong> it takes a permanent snapshot of this
          year's numbers and saves it here in History so you can compare years over time. Closing a year never changes your
          live financials, and you can <em>reopen</em> a year at any time to remove its snapshot. Switch the year using the
          selector in the top bar.
        </div>
      </div>

      {close.isSuccess && <p className="badge good" style={{ marginBottom: 12 }}>Snapshot saved for {year}</p>}
      {close.isError && <p className="badge danger" style={{ marginBottom: 12 }}>{close.error.message}</p>}
      {reopen.isSuccess && <p className="badge info" style={{ marginBottom: 12 }}>FY {year} reopened — snapshot removed.</p>}

      {sorted.length === 0 ? (
        <p className="muted">No closed years yet. Use “Close FY {year}” to snapshot this year.</p>
      ) : (
        <>
          {/* YoY delta strip: selected FY vs prior available year */}
          {cur && (
            <div className="yoy-strip">
              <DeltaCard label="Revenue" cur={num(cur.total_revenue)} prev={prev ? num(prev.total_revenue) : null} prevYear={prev?.year} favorable="up" />
              <DeltaCard label="Total expenses" cur={expenses(cur)} prev={prev ? expenses(prev) : null} prevYear={prev?.year} favorable="down" />
              <DeltaCard label="NOI" cur={noi(cur)} prev={prev ? noi(prev) : null} prevYear={prev?.year} favorable="up" />
              {snapshotCollectionSummary(cur) && (
                <DeltaCard
                  label="Collected"
                  cur={snapshotCollectionSummary(cur).collected}
                  prev={snapshotCollectionSummary(prev)?.collected ?? null}
                  prevYear={prev?.year}
                  favorable="up"
                />
              )}
            </div>
          )}

          <div className="chart-legend">
            <span><span className="sw" style={{ background: '#5C6B3C' }} /> Revenue</span>
            <span><span className="sw" style={{ background: '#9C7430' }} /> Total expenses</span>
            <span><span className="sw" style={{ background: '#2E4636' }} /> NOI</span>
          </div>
          <div className="hist-chart" style={{ height: 300, marginBottom: 24 }}>
            <ResponsiveContainer>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(27,24,19,.1)" />
                <XAxis dataKey="year" /><YAxis tickFormatter={kfmt} /><Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="Revenue" fill="#5C6B3C">
                  <LabelList dataKey="Revenue" position="top" formatter={kfmt} className="bar-label" />
                </Bar>
                <Bar dataKey="Expenses" fill="#9C7430">
                  <LabelList dataKey="Expenses" position="top" formatter={kfmt} className="bar-label" />
                </Bar>
                <Bar dataKey="NOI" fill="#2E4636">
                  <LabelList dataKey="NOI" position="top" formatter={kfmt} className="bar-label" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="table-wrap" style={{ marginBottom: 24 }}>
            <table>
              <thead>
                <tr><th>Year</th><th className="num">Revenue</th><th className="num">Taxes</th><th className="num">CAM</th><th className="num">Roof</th><th className="num">Total exp.</th><th className="num">NOI</th><th className="num">NOI Δ</th><th className="num">Collected</th><th className="num">Rate</th></tr>
              </thead>
              <tbody>
                {sorted.map((s, i) => {
                  const prevNoi = i > 0 ? noi(sorted[i - 1]) : null;
                  const d = prevNoi ? ((noi(s) - prevNoi) / Math.abs(prevNoi)) * 100 : null;
                  const col = snapshotCollectionSummary(s);
                  return (
                    <tr key={s.id} className={s.year === year ? 'hl-row' : ''}>
                      <td>{s.year}{s.year === year ? ' · viewing' : ''}</td>
                      <td className="num">{money(s.total_revenue)}</td>
                      <td className="num">{money(s.taxes_total)}</td>
                      <td className="num">{money(s.cam_total)}</td>
                      <td className="num">{money(s.roof_total)}</td>
                      <td className="num">{money(expenses(s))}</td>
                      <td className="num">{money(noi(s))}</td>
                      <td className="num">{d == null ? '—' : <span className={d >= 0 ? 'pos' : 'neg'}>{d >= 0 ? '▲' : '▼'} {Math.abs(d).toFixed(1)}%</span>}</td>
                      <td className="num">{col ? money(col.collected) : '—'}</td>
                      <td className="num">{col?.rate != null ? `${Math.round(col.rate * 100)}%` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="callout" style={{ marginBottom: 24 }}>
            <div className="between">
              <div className="alert-main"><div className="alert-title"><strong>AI year-over-year summary</strong></div></div>
              <button onClick={generate} disabled={busy}>{busy ? 'Writing…' : narrative ? 'Regenerate' : 'Generate summary'}</button>
            </div>
            {narrative && <p style={{ marginTop: 8, marginBottom: 0 }}>{narrative}</p>}
          </div>
        </>
      )}

      {/* Who has occupied this building — one card per tenant, current and former.
          Replaces the old pair of sections (a flat event table that was nearly always
          empty, and a separate archive table): a tenant's whole record now reads in one
          place, headed by the property so you always know where you are. */}
      <div className="exp-block" style={{ marginBottom: 24 }}>
        <div className="exp-head">
          <div>
            <strong>Who has occupied {prop?.name || 'this property'}</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Every tenant this building has had, current and former — when they moved in, what
              changed while they were here, and how their tenancy ended. Open one to read its record.
            </div>
          </div>
          {events.length > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={clearHistory.isPending}
              onClick={async () => {
                if (await askConfirm({
                  title: 'Clear lease & tenant history?',
                  message: `Clear ${prop?.name || 'this property'}'s recorded history?`,
                  implications: [
                    'Permanently deletes every recorded event — renewals, assignments, insurance requests, CAM reconciles and statement imports.',
                    'Also clears the "📨 Last requested" date shown on tenants’ insurance panels.',
                    'Each tenant keeps their move-in and term dates — those come from the leases themselves.',
                    'Your leases, tenants, invoices and archived prior terms are NOT affected.',
                    'This can’t be undone.',
                  ],
                  confirmLabel: 'Clear history',
                })) clearHistory.mutate();
              }}
            >{clearHistory.isPending ? 'Clearing…' : 'Clear history'}</button>
          )}
        </div>
        {clearHistory.isError && <p className="badge danger" style={{ marginTop: 10 }}>{clearHistory.error.message}</p>}
        {stories.length === 0 ? (
          <p className="muted" style={{ marginTop: 14 }}>No tenants on record for this property yet.</p>
        ) : (
          <div className="story-list">
            {stories.map((s) => (
              <StoryCard
                key={s.key}
                story={s}
                open={openStory === s.key}
                onToggle={() => setOpenStory(openStory === s.key ? null : s.key)}
                openDoc={openExp === s.key}
                onToggleDoc={() => setOpenExp(openExp === s.key ? null : s.key)}
                onRemove={s.expiredId ? async () => {
                  if (await askConfirm({
                    title: 'Remove archived lease?',
                    message: `Remove ${s.tenant}'s archived lease from History?`,
                    implications: [
                      'Permanently deletes this archived record and its stored financials.',
                      'This can’t be undone.',
                    ],
                    confirmLabel: 'Remove',
                  })) removeExpired.mutate(s.expiredId);
                } : null}
                removing={removeExpired.isPending}
              />
            ))}
          </div>
        )}
      </div>

      {/* Bookkeeping log — the events that happened to the BOOKS rather than to a tenancy.
          They used to sit in the tenant timeline above, where the two statement events
          rendered "—" in the Tenant column because they carry no tenant at all. */}
      {ledger.length > 0 && (
        <div className="exp-block">
          <button type="button" className="panel-toggle" aria-expanded={showLedger} onClick={() => setShowLedger((o) => !o)}>
            <span className="panel-caret" aria-hidden="true">{showLedger ? '▾' : '▸'}</span>
            <strong>Bookkeeping log</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {ledger.length} entr{ledger.length === 1 ? 'y' : 'ies'} · CAM reconciles, estimates and statement imports
            </span>
          </button>
          {showLedger && (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table style={{ minWidth: 0 }}>
                <thead><tr><th>When</th><th>Tenant</th><th>Event</th><th>Detail</th></tr></thead>
                <tbody>
                  {ledger.map((ev) => (
                    <tr key={ev.id}>
                      <td>{fmtDate(ev.event_date || ev.created_at)}</td>
                      <td>{ev.tenant_name || '—'}</td>
                      <td><span className={`badge ${EVENT_BADGE[ev.type] || 'info'}`}>{EVENT_LABEL[ev.type] || ev.type}</span></td>
                      <td>{ev.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One tenant's record. Folded by default — and collapsed it still states what it holds
// (size, rent, term, how many changes), following the .panel-toggle rule the Rent
// escalations panel established: a fold that hides its own summary just makes you open it.
function StoryCard({ story: s, open, onToggle, openDoc, onToggleDoc, onRemove, removing }) {
  const changes = s.events.filter((e) => !e.synthetic).length;
  const summary = [
    s.address || null,
    s.sf > 0 ? sf(s.sf) : null,
    s.rent > 0 ? `${money(s.rent)}/yr` : null,
    s.status === 'current'
      ? (s.end ? `${s.holdover ? 'term ended' : 'term ends'} ${fmtDate(s.end)}` : 'no term end on file')
      : (s.end ? `left ${fmtDate(s.end)}` : null),
    `${changes} recorded change${changes === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`story-card${s.status === 'former' ? ' former' : ''}`}>
      <button type="button" className="panel-toggle story-head" aria-expanded={open} onClick={onToggle}>
        <span className="panel-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <strong>{s.tenant}</strong>
        {s.status === 'current'
          ? (s.holdover
            ? <span className="badge danger">Holdover</span>
            : s.needsExtension
              ? <span className="badge warn">Needs extension</span>
              : <span className="badge good">Current</span>)
          : <span className={`badge ${s.outcome === 'Renewed' ? 'good' : s.outcome === 'Terminated' ? 'danger' : 'info'}`}>{s.outcome || 'Former'}</span>}
      </button>
      <div className="story-summary muted">{summary}</div>
      {open && (
        <div className="story-body">
          {s.events.length === 0 ? (
            <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>No dates on file for this tenancy.</p>
          ) : (
            <ol className="story-timeline">
              {s.events.map((e, i) => (
                <li key={e.id || `${e.type}-${i}`}>
                  <span className="story-when">{fmtDate(e.date)}</span>
                  <span className={`badge ${EVENT_BADGE[e.type] || 'info'}`}>{e.label || EVENT_LABEL[e.type] || e.type}</span>
                  {e.description && <span className="story-what">{e.description}</span>}
                </li>
              ))}
            </ol>
          )}
          {(s.leaseText || onRemove) && (
            <div className="row" style={{ gap: 8, alignItems: 'center', marginTop: 12 }}>
              {s.leaseText && (
                <button type="button" className="ghost" onClick={onToggleDoc}>{openDoc ? 'Close' : 'Open & ask'}</button>
              )}
              {onRemove && (
                <button type="button" className="icon-btn danger-btn" title="Remove this archived lease from History" disabled={removing} onClick={onRemove}>✕</button>
              )}
            </div>
          )}
          {openDoc && s.leaseText && (
            <div className="exp-doc-panel" style={{ marginTop: 12 }}>
              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 10 }}>
                {s.status === 'former' ? 'Archived lease' : 'Lease'} — {s.tenant}
              </div>
              <LeaseAssistant leaseText={s.leaseText} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeltaCard({ label, cur, prev, prevYear, favorable }) {
  if (prev == null || prev === 0) {
    return (
      <div className="yoy">
        <div className="yoy-l">{label}</div>
        <div className="yoy-v">{money(cur)}</div>
        <div className="yoy-sub">no prior year</div>
      </div>
    );
  }
  const pctChange = ((cur - prev) / Math.abs(prev)) * 100;
  const up = pctChange >= 0;
  const good = favorable === 'up' ? up : !up;
  return (
    <div className="yoy">
      <div className="yoy-l">{label}</div>
      <div className={`yoy-v ${good ? 'pos' : 'neg'}`}>{up ? '▲' : '▼'} {Math.abs(pctChange).toFixed(1)}%</div>
      <div className="yoy-sub">{money(cur)} · vs {prevYear}</div>
    </div>
  );
}
