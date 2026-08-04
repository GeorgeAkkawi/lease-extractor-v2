// One place that knows what goes stale when a BILLED figure moves.
//
// Every money screen in the app is downstream of a handful of stored figures, but the
// chain isn't visible from the component you happen to be editing — so each editor grew
// its own hand-rolled invalidation list, and the lists drifted apart by omission. That
// drift is exactly how a stored invoice could keep billing last month's figures while
// the Financials breakdown and the Ledger grid (which build UP from live data) had
// already moved on.
//
// Call this after anything that changes what a tenant is billed: a lease money field, a
// rent step, an abatement, the building size, a CAM / tax / roof total. It covers the
// SHARED consequences only — each editor still invalidates its own list (escalations,
// camLineItems, …), because that part genuinely is local to it.
//
// Deliberately separate from settleStatementImport (ImportStatementButton.js), which is
// a wider statement-specific set: an import also touches the import register, learned
// payee rules and the property's history. Two named sets beat one that fits neither.
export function settleBillingChange(qc, { propertyId, leaseId, year } = {}) {
  const keys = [
    // What the figure re-splits into.
    propertyId ? ['tenantShares', propertyId] : ['tenantShares'],
    propertyId ? ['propertyTotals', propertyId] : ['propertyTotals'],
    // The Ledger grid + the lease's own monthly boxes.
    propertyId ? ['propertyRentRoll', propertyId] : ['propertyRentRoll'],
    ['monthlyRent'],
    // The stored invoice the resync just moved, and its payments.
    ['invoices'],
    ['payments'],
    // The lease row (base rent can move with an escalation) and the lists that show it.
    leaseId ? ['lease', leaseId] : ['lease'],
    propertyId ? ['leases', propertyId] : ['leases'],
    // Per-month charges and credits (0082) — the Ledger cells, the month panel and the
    // lease's tenant statement all read them.
    ['adjustments'],
    // The statement importer's match context carries each tenant's per-month owed, so a
    // charge must reach it or a deposit covering it reads as "over" (and can trip the
    // already-recorded collision guard).
    ['statementContext'],
    // Roll-ups and anything that reads an invoice balance.
    ['corpRollups'],
    // The Overview's "so far this year" bars — collected + expenses paid to date, per
    // property. It reads the same invoices/payments this just moved.
    ['portfolioCollected'],
    ['alerts'],
  ];
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

// One place that knows what goes stale when a lease APPEARS, DISAPPEARS or is RENAMED.
//
// THREE query keys render a lease list, and two of them are BATCH keys nobody was
// invalidating:
//   ['leases', propId]            — the property lists + the card fly-out          (was covered)
//   ['sidebarLeases', <ids>]      — Sidebar.js, the hover fly-out's tenant level   (was NOT)
//   ['leasesByProperties', corpId]— prefetch.js, seeds the per-property caches     (was NOT)
//
// Missing the two batch keys is not a five-minute staleness — it is permanent for the
// session. Sidebar is mounted for the life of the app (Layout.js), and the client defaults
// are staleTime 5min / gcTime Infinity / refetchOnWindowFocus false (index.js), so a query
// whose observer never unmounts and has no refetch trigger NEVER refetches. A tenant you
// removed kept appearing in the fly-out until a hard reload (George, 2026-08-04).
//
// Both batch keys are invalidated by PREFIX: their full key carries a joined id string the
// caller doesn't hold.
export function settleLeaseListChange(qc, { propertyId } = {}) {
  qc.invalidateQueries({ queryKey: propertyId ? ['leases', propertyId] : ['leases'] });
  qc.invalidateQueries({ queryKey: ['sidebarLeases'] });
  qc.invalidateQueries({ queryKey: ['leasesByProperties'] });
}

export default settleBillingChange;
