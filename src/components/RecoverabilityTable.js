// Slice 3 — "What it cost you": spent, recovered from tenants, your net cost, by tax
// category. The headline of the accounting arc, and it needs no schema at all: every
// figure is derived from data two other sections of this same page already render.
//
// It supersedes the CAM-only roll-up Slice 2 shipped inside CamSection, which covered
// one of the three itemized sections and said so in its own footnote. This covers all
// three, and adds the column that makes it worth reading.
import { useQuery } from '@tanstack/react-query';
import { getTenantShares, listCamLineItems, listTaxLineItems, listRoofLineItems, listExpenseBuckets, getExpenseRecord, listEscalationsByLeases } from '../lib/api';
import { recoverabilityRows } from '../lib/recoverability';
import { inTermByLease } from '../lib/leaseSchedule';
import { money } from '../lib/format';
import Panel from './Panel';

export default function RecoverabilityTable({ propId, year }) {
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
  // ⚠ The SAME query key TenantShareTable uses on this very page, so this is a cache hit
  // rather than a second fetch — and, more to the point, so the Recovered column here can
  // never weigh a mid-year tenant differently from the Estimated/Difference columns in the
  // breakdown below it. One query for the whole property, never one per lease.
  const { data: escByLease, isSuccess: escReady } = useQuery({
    queryKey: ['escalationsByLeases', propId, shares.map((s) => s.lease_id).join(',')],
    queryFn: () => listEscalationsByLeases(shares.map((s) => s.lease_id)),
    enabled: shares.length > 0,
  });

  const items = [...taxItems, ...camItems, ...roofItems];
  // ⚠ NOT WEIGHED UNTIL THE STEPS ARE IN HAND. Weighing from `lease_start` alone, with the
  // escalations still in flight, prorates a RENEWED tenant as though the tenancy began at
  // its catch-up date — a third figure, briefly on screen, that is neither the old
  // unprorated one nor the right one. Passing null until the query settles means the worst
  // case is the figure this table showed before 2026-08-16, which is at least coherent —
  // and it is also what a failed query leaves behind.
  const { rows, totals, owner, ownerTotal } = recoverabilityRows({
    items, shares, expense: expense || {}, buckets,
    inTermByLease: escReady ? inTermByLease({ year, shares, escByLease: escByLease || {} }) : null,
  });

  // Nothing spent yet — the expense sections above already say so; a table of zeroes
  // would just be noise on a page that is otherwise asking you to fill them in. A year
  // with ONLY distributions still renders: those lines have to be visible somewhere,
  // and this is where the landlord comes looking for money that left the account.
  if (totals.spent <= 0 && ownerTotal <= 0) return null;

  const pct = totals.spent > 0 ? (totals.recovered / totals.spent) * 100 : 0;

  return (
    <Panel
      id="fin.cost"
      title={`What it cost you — FY ${year}`}
      hint="What you spent, what your tenants pay back, and what you carry — by category."
      // Folded, it still answers the question the panel exists for. All three figures are
      // already computed above; folding this must never cost the landlord the net cost.
      summary={`Spent ${money(totals.spent)} · recovered ${money(totals.recovered)} · your net cost ${money(totals.net)}`}
    >
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

        {/* ⚠ BELOW THE TOTAL, NEVER INSIDE IT. Money the owner took out is a real bank
            line and has to be visible, but it is not a cost of the building — so it sits
            under the totals band rather than as another category above it, and
            `recoverabilityRows` has already kept it out of every figure there.
            (Before 2026-08-12 these lived in an "Owner & entity money" panel of their
            own; the panel went, the distinction did not.) */}
        {owner.map((r) => (
          <div className="recov-row recov-owner" key={r.key}>
            <div>
              {r.label}
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {r.buckets.join(' · ')} — not a cost of the building, and in none of the figures above
              </div>
            </div>
            <div className="num"><span className="stat-label">Taken out</span>{money(r.spent)}</div>
            <div className="num recov-back"><span className="stat-label">Recovered</span>—</div>
            <div className="num recov-net"><span className="stat-label">Your net cost</span>—</div>
          </div>
        ))}
      </div>

      <div className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        <strong>Recovered</strong> is each tenant's actual pro-rata share for the year — what the
        year-end reconciliation entitles you to collect, whatever estimate they're paying meanwhile.
        The gap is what you carry: vacant space nobody is billed for, any line marked
        <em> not billed to tenants</em>, roof work on leases that don't make the tenant responsible,
        {/* ⚠ THE FOURTH CAUSE, AND IT WAS UNNAMED UNTIL 2026-08-16. A tenant who moved in
            mid-year covers only the months they were here — the same proration ⚖ Reconcile
            settles them at. Without this clause the extra gap reads as an error in a
            correct figure. */}
        {' '}and the part of the year before a tenant moved in — a mid-year tenancy covers only
        the months it ran, exactly as its reconciliation settles.
      </div>
    </Panel>
  );
}

// ⚠ THE CAM-CAP CAVEAT LIVED HERE AND WAS REMOVED (George, 2026-08-12: "take this feature
// out entirely"). It was a gold box naming every lease the AI review had flagged
// `cam_capped`, quoting the clause, and warning that a real cap would mean recovering less
// than this table shows. It cost a third of the panel's height for a caveat that, on the one
// lease that ever raised it, quoted a clause describing an ESTIMATE with a true-up — the
// opposite of a cap. It also never honoured `dismissed_keys`, so dismissing the finding on
// the lease page left the box on screen with no way to answer it.
//
// The CHECK ITSELF IS UNTOUCHED. `cam_capped` is still one of the review's flags
// (_shared/leaseFlags.js) and still shows on the lease's own page in LeaseReviewStrip, where
// it carries its note, its quote and a ✕ that remembers. What went is the second surface, on
// a table that could only repeat the warning and never resolve it.
