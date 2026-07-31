// Slice 3 — "What it cost you": spent, recovered from tenants, your net cost, by tax
// category. The headline of the accounting arc, and it needs no schema at all: every
// figure is derived from data two other sections of this same page already render.
//
// It supersedes the CAM-only roll-up Slice 2 shipped inside CamSection, which covered
// one of the three itemized sections and said so in its own footnote. This covers all
// three, and adds the column that makes it worth reading.
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getTenantShares, listCamLineItems, listTaxLineItems, listRoofLineItems, listExpenseBuckets, listLeaseReviews, getExpenseRecord } from '../lib/api';
import { recoverabilityRows } from '../lib/recoverability';
import { cappedLeases } from '../lib/leaseRisks';
import { money } from '../lib/format';

export default function RecoverabilityTable({ propId, corpId, year }) {
  const { data: shares = [] } = useQuery({ queryKey: ['tenantShares', propId, year], queryFn: () => getTenantShares(propId, year) });
  const { data: buckets = [] } = useQuery({ queryKey: ['expenseBuckets'], queryFn: listExpenseBuckets });
  // The three itemized sections' OWN keys, so every existing invalidation on this page
  // repaints this table too — adding a CAM line moves the table with no new plumbing.
  const { data: camItems = [] } = useQuery({ queryKey: ['camLineItems', propId, year], queryFn: () => listCamLineItems(propId, year) });
  const { data: taxItems = [] } = useQuery({ queryKey: ['taxLineItems', propId, year], queryFn: () => listTaxLineItems(propId, year) });
  const { data: roofItems = [] } = useQuery({ queryKey: ['roofLineItems', propId, year], queryFn: () => listRoofLineItems(propId, year) });
  // Same query key the page and the three expense sections use, so this is a cache hit
  // and the table can never read a different total than the sections above it.
  const { data: expense } = useQuery({ queryKey: ['expenseRecord', propId, year], queryFn: () => getExpenseRecord(propId, year) });
  const { data: reviews = [] } = useQuery({ queryKey: ['leaseReviews', propId], queryFn: () => listLeaseReviews(propId) });

  const items = [...taxItems, ...camItems, ...roofItems];
  const { rows, totals } = recoverabilityRows({ items, shares, expense: expense || {}, buckets });
  const capped = cappedLeases(reviews);

  // Nothing spent yet — the expense sections above already say so; a table of zeroes
  // would just be noise on a page that is otherwise asking you to fill them in.
  if (totals.spent <= 0) return null;

  const pct = totals.spent > 0 ? (totals.recovered / totals.spent) * 100 : 0;

  return (
    <div className="panel">
      <div className="page-head" style={{ marginTop: 0 }}>
        <h3 className="section-title" style={{ margin: 0 }}>What it cost you — FY {year}</h3>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: -6, marginBottom: 14 }}>
        What you spent, what your tenants pay back, and what you carry — by the line of your
        return each bucket rolls up to.
      </p>

      <div className="recov-table">
        <div className="recov-row recov-th">
          <div>Category</div>
          <div className="num">Spent</div>
          <div className="num">Recovered from tenants</div>
          <div className="num">Your net cost</div>
        </div>

        {rows.map((r) => (
          <div className={`recov-row${r.key ? '' : ' cat-none'}`} key={r.key || 'uncategorized'}>
            <div>
              {r.label}
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {r.buckets.join(' · ')}
                {r.anyFlat && ' — entered as one figure, not itemized'}
                {!r.key && ' — pick a category on the lines above'}
              </div>
            </div>
            {/* .stat-label is the shared self-labelling mechanism: screen-reader-only on
                desktop (where the header band carries the labels), visible once the row
                reflows to three-across on a phone. */}
            <div className="num"><span className="stat-label">Spent</span>{money(r.spent)}</div>
            <div className="num recov-back"><span className="stat-label">Recovered</span>{r.recovered > 0 ? money(r.recovered) : '—'}</div>
            <div className="num recov-net"><span className="stat-label">Your net cost</span>{money(r.net)}</div>
          </div>
        ))}

        <div className="recov-row recov-total">
          <div>
            <b>Total</b>
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              Tenants cover {pct.toFixed(1)}% of what you spend
            </div>
          </div>
          <div className="num"><span className="stat-label">Spent</span><b>{money(totals.spent)}</b></div>
          <div className="num recov-back"><span className="stat-label">Recovered</span><b>{money(totals.recovered)}</b></div>
          <div className="num recov-net"><span className="stat-label">Your net cost</span><b>{money(totals.net)}</b></div>
        </div>
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        <strong>Recovered</strong> is each tenant's actual pro-rata share for the year — what the
        year-end reconciliation entitles you to collect, whatever estimate they're paying meanwhile.
        The gap is what you carry: vacant space nobody is billed for, any line marked
        <em> not billed to tenants</em>, and roof work on leases that don't make the tenant responsible.
      </div>

      {capped.length > 0 && (
        <div className="note-msg warn" style={{ marginTop: 12 }}>
          <strong>Check {capped.length === 1 ? 'this lease' : 'these leases'} before relying on the recovered figure.</strong>{' '}
          The lease review flagged {capped.length === 1 ? 'it' : 'them'} as possibly capping the
          tenant's share of operating expenses. Amlak bills — and this table counts — the full
          pro-rata share, so a real cap would mean you recover less than shown.
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {capped.map((c) => (
              <li key={c.id} style={{ marginBottom: 6 }}>
                <Link to={`/leases/${corpId}/${propId}/${c.id}`}>{c.tenant_name}</Link>
                {c.quote && <div className="muted" style={{ fontSize: 11, marginTop: 2, fontStyle: 'italic' }}>“{c.quote}”</div>}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 6, fontSize: 11 }}>
            Read the clause: if it doesn't actually cap anything, the figure above is right as it stands.
          </div>
        </div>
      )}
    </div>
  );
}
