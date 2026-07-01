import { useState, Fragment } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList,
} from 'recharts';
import { getCorporation, getProperty, listSnapshots, listExpiredLeases, deleteExpiredLease, closeYear, reopenYear, listHistoryEvents } from '../lib/api';
import { invokeFunction } from '../lib/supabaseClient';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { money, psf, sf, fmtDate } from '../lib/format';
import LeaseAssistant from '../components/LeaseAssistant';

// Friendly labels + badge tones for the history_events timeline.
const EVENT_LABEL = {
  tenant_assigned: 'Tenant assigned',
  term_extended: 'Term extended',
  renewal_confirmed: 'Renewal confirmed',
  renewal_declined: 'Renewal declined',
  rent_stepped: 'Rent step',
  lease_created: 'Lease created',
};
const EVENT_BADGE = {
  tenant_assigned: 'info',
  term_extended: 'good',
  renewal_confirmed: 'good',
  renewal_declined: 'danger',
};

const num = (v) => (v == null ? 0 : Number(v));
const expenses = (s) => num(s.taxes_total) + num(s.cam_total) + num(s.roof_total);
const noi = (s) => num(s.total_revenue) - expenses(s);
// compact $k label for axis ticks and the value labels drawn on each bar
const kfmt = (v) => (v == null || isNaN(v) ? '' : Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

export default function HistoryPage() {
  const { corpId, propId } = useParams();
  const qc = useQueryClient();
  const { year } = useChrome();

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: snaps = [] } = useQuery({ queryKey: ['snapshots', propId], queryFn: () => listSnapshots(propId) });
  const { data: expired = [] } = useQuery({ queryKey: ['expiredLeases', propId], queryFn: () => listExpiredLeases(propId) });
  const { data: events = [] } = useQuery({ queryKey: ['historyEvents', propId], queryFn: () => listHistoryEvents(propId) });
  usePageChrome([
    { label: 'History', to: '/history' },
    { label: corp?.name || '…', to: `/history/${corpId}` },
    { label: prop?.name || '…' },
  ], true);

  const close = useMutation({ mutationFn: () => closeYear(propId, year), onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshots', propId] }) });
  const reopen = useMutation({ mutationFn: () => reopenYear(propId, year), onSuccess: () => qc.invalidateQueries({ queryKey: ['snapshots', propId] }) });
  const removeExpired = useMutation({ mutationFn: (id) => deleteExpiredLease(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['expiredLeases', propId] }) });

  const [narrative, setNarrative] = useState('');
  const [busy, setBusy] = useState(false);
  const [showExpired, setShowExpired] = useState(false);
  const [openExp, setOpenExp] = useState(null); // expired lease id whose document/assistant is open

  const sorted = [...snaps].sort((a, b) => a.year - b.year);
  const idx = sorted.findIndex((s) => s.year === year);
  const cur = idx >= 0 ? sorted[idx] : null;
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const closed = !!cur; // this fiscal year already has a saved snapshot

  function handleClose() {
    if (window.confirm(
      `Close FY ${year}?\n\nThis saves a permanent snapshot of this property's revenue, expenses, and per-tenant breakdown exactly as they are now, and files it under History. It does NOT change your live financials — you can edit them anytime, and you can reopen the year later to remove the snapshot.`
    )) close.mutate();
  }
  function handleReopen() {
    if (window.confirm(
      `Reopen FY ${year}?\n\nThis removes the saved snapshot for ${year} from History. Your live financials for ${year} are not affected.`
    )) reopen.mutate();
  }

  const chartData = sorted.map((s) => ({ year: String(s.year), Revenue: num(s.total_revenue), Expenses: expenses(s), NOI: noi(s) }));

  async function generate() {
    setBusy(true);
    try {
      const { narrative } = await invokeFunction('trends-narrative', {
        property_name: prop?.name,
        series: sorted.map((s) => ({ year: s.year, total_revenue: num(s.total_revenue), taxes_total: num(s.taxes_total), cam_total: num(s.cam_total), roof_total: num(s.roof_total), total_expenses: expenses(s), noi: noi(s) })),
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
            </div>
          )}

          <div className="chart-legend">
            <span><span className="sw" style={{ background: '#5C6B3C' }} /> Revenue</span>
            <span><span className="sw" style={{ background: '#B98B3A' }} /> Total expenses</span>
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
                <Bar dataKey="Expenses" fill="#B98B3A">
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
                <tr><th>Year</th><th className="num">Revenue</th><th className="num">Taxes</th><th className="num">CAM</th><th className="num">Roof</th><th className="num">Total exp.</th><th className="num">NOI</th><th className="num">NOI Δ</th></tr>
              </thead>
              <tbody>
                {sorted.map((s, i) => {
                  const prevNoi = i > 0 ? noi(sorted[i - 1]) : null;
                  const d = prevNoi ? ((noi(s) - prevNoi) / Math.abs(prevNoi)) * 100 : null;
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

      {/* Lease & tenant history — this building's own timeline of what happened */}
      <div className="exp-block" style={{ marginBottom: 24 }}>
        <div className="exp-head">
          <div>
            <strong>Lease &amp; tenant history</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Every change this building's leases have been through — tenant assignments, term extensions, and renewal decisions — newest first.</div>
          </div>
        </div>
        {events.length === 0 ? (
          <p className="muted" style={{ marginTop: 14 }}>No recorded changes yet for this property.</p>
        ) : (
          <div className="table-wrap" style={{ marginTop: 14 }}>
            <table style={{ minWidth: 0 }}>
              <thead><tr><th>When</th><th>Event</th><th>Detail</th></tr></thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td>{fmtDate(ev.event_date || ev.created_at)}</td>
                    <td><span className={`badge ${EVENT_BADGE[ev.type] || 'info'}`}>{EVENT_LABEL[ev.type] || ev.type}</span></td>
                    <td>{ev.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Expired & renewed leases */}
      <div className="exp-block">
        <div className="exp-head">
          <div>
            <strong>Expired &amp; renewed leases</strong>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>Prior lease terms archived here once a renewal, turnover, or termination takes effect.</div>
          </div>
          <button className="secondary" onClick={() => setShowExpired((o) => !o)}>
            {showExpired ? 'Hide' : `Show ${expired.length} expired lease${expired.length === 1 ? '' : 's'}`}
          </button>
        </div>
        {showExpired && (
          expired.length === 0 ? (
            <p className="muted" style={{ marginTop: 14 }}>No expired leases on record for this property.</p>
          ) : (
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table>
                <thead><tr><th>Tenant</th><th className="num">SF</th><th className="num">Base rent</th><th>Term</th><th>Outcome</th><th>Lease</th></tr></thead>
                <tbody>
                  {expired.map((e) => (
                    <Fragment key={e.id}>
                      <tr>
                        <td>{e.tenant_name}</td>
                        <td className="num">{sf(e.sf)}</td>
                        <td className="num">{money(e.base_rent)}<div className="cell-sub">{e.sf > 0 ? psf(e.base_rent / e.sf) : ''}</div></td>
                        <td>{fmtDate(e.lease_start)} – {fmtDate(e.lease_end)}</td>
                        <td>
                          <div className="outcome">
                            <span className={`badge ${e.status === 'Renewed' ? 'good' : e.status === 'Terminated' ? 'danger' : 'info'}`}>{e.status}</span>
                            {e.note && <span className="exp-note muted">{e.note}</span>}
                          </div>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                            {e.lease_text
                              ? <button type="button" className="ghost" onClick={() => setOpenExp(openExp === e.id ? null : e.id)}>{openExp === e.id ? 'Close' : 'Open & ask'}</button>
                              : <span className="muted" style={{ fontSize: 12 }}>—</span>}
                            <button
                              type="button"
                              className="icon-btn danger-btn"
                              title="Remove this archived lease from History"
                              disabled={removeExpired.isPending}
                              onClick={() => { if (window.confirm(`Remove ${e.tenant_name}'s archived lease from History? This deletes the record permanently.`)) removeExpired.mutate(e.id); }}
                            >✕</button>
                          </div>
                        </td>
                      </tr>
                      {openExp === e.id && (
                        <tr className="exp-doc-row">
                          <td colSpan={6}>
                            <div className="exp-doc-panel">
                              <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 10 }}>
                                Archived lease — {e.tenant_name}
                              </div>
                              <LeaseAssistant leaseText={e.lease_text} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
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
