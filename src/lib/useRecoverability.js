import { useQuery } from '@tanstack/react-query';
import {
  getTenantShares, listCamLineItems, listTaxLineItems, listRoofLineItems,
  listExpenseBuckets, getExpenseRecord, listEscalationsByLeases,
} from './api';
import { recoverabilityRows } from './recoverability';
import { inTermByLease } from './leaseSchedule';

/**
 * One property-year's recoverability figures, loaded once for every surface that needs them.
 *
 * ⚠ WHY THIS IS A HOOK AND NOT A SECOND QUERY BLOCK. Two panels on the Financials page now
 * quote the SAME reimbursement: the "Recovered from tenants" column in *What it cost you*
 * (`RecoverabilityTable`) and the "Tenants reimbursed" line in *What actually stayed*
 * (`WhatStayedStrip`, 2026-08-21). If each assembled its own inputs they would be free to
 * disagree — two reimbursement figures, one page, a few hundred pixels apart, and only one of
 * them right in front of an accountant (CLAUDE.md §3).
 *
 * ⚠ EVERY QUERY KEEPS THE KEY ITS OWN SECTION ALREADY USES — `camLineItems`, `taxLineItems`,
 * `roofLineItems`, `expenseRecord`, `tenantShares`, `expenseBuckets`, `escalationsByLeases`.
 * That is not tidiness: it means both callers are cache HITS off queries the page has already
 * made, and that every existing invalidation on this page repaints them both with no new
 * plumbing. Adding a CAM line moves the table and the strip together, as it did before.
 *
 * ⚠ AND THE `ready` GATE IS LOAD-BEARING, NOT A LOADING FLAG. `inTermByLease` is passed as
 * NULL until the escalations query settles, deliberately: weighing a tenant's recovery from
 * `lease_start` with the steps still in flight prorates a RENEWED tenant as though the tenancy
 * began at its catch-up date — a third figure, briefly on screen, that is neither the old
 * unprorated one nor the right one. It lived in `RecoverabilityTable` and moved here whole, so
 * the strip cannot gate differently and quote a different recovered figure mid-load.
 */
export default function useRecoverability(propId, year) {
  const { data: shares = [] } = useQuery({
    queryKey: ['tenantShares', propId, year],
    queryFn: () => getTenantShares(propId, year),
  });
  const { data: buckets = [] } = useQuery({ queryKey: ['expenseBuckets'], queryFn: listExpenseBuckets });
  const { data: camItems = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    queryFn: () => listCamLineItems(propId, year),
  });
  const { data: taxItems = [] } = useQuery({
    queryKey: ['taxLineItems', propId, year],
    queryFn: () => listTaxLineItems(propId, year),
  });
  const { data: roofItems = [] } = useQuery({
    queryKey: ['roofLineItems', propId, year],
    queryFn: () => listRoofLineItems(propId, year),
  });
  const { data: expense } = useQuery({
    queryKey: ['expenseRecord', propId, year],
    queryFn: () => getExpenseRecord(propId, year),
  });
  const { data: escByLease, isSuccess: escReady } = useQuery({
    queryKey: ['escalationsByLeases', propId, shares.map((s) => s.lease_id).join(',')],
    queryFn: () => listEscalationsByLeases(shares.map((s) => s.lease_id)),
    enabled: shares.length > 0,
  });

  // ⚠ ALL THREE KINDS, and the order is the one `RecoverabilityTable` has always used. The
  // strip used to see CAM alone, which is how a not-billed TAX or ROOF line became money it
  // never subtracted — see WhatStayedStrip.
  const items = [...taxItems, ...camItems, ...roofItems];
  const rec = recoverabilityRows({
    items, shares, expense: expense || {}, buckets,
    inTermByLease: escReady ? inTermByLease({ year, shares, escByLease: escByLease || {} }) : null,
  });

  return { ...rec, items, buckets, shares, ready: escReady };
}
