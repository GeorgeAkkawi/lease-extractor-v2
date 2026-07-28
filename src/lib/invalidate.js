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
    // Roll-ups and anything that reads an invoice balance.
    ['corpRollups'],
    ['alerts'],
  ];
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

export default settleBillingChange;
