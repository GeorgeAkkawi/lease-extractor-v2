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
    // The dated estimate ledger (0089). It is READ by every screen that prices a month —
    // the Financials breakdown, the Ledger grid, the reconcile — so a figure that writes a
    // row here and doesn't invalidate it leaves those screens pricing from the ledger as it
    // stood BEFORE the change. Missing since 0089 shipped.
    ['leaseEstimates'],
    // The statement importer's match context carries each tenant's per-month owed, so a
    // charge must reach it or a deposit covering it reads as "over" (and can trip the
    // already-recorded collision guard).
    ['statementContext'],
    // Roll-ups and anything that reads an invoice balance.
    ['corpRollups'],
    // The Overview's "so far this year" bars — collected + expenses paid to date, per
    // property. It reads the same invoices/payments this just moved.
    ['portfolioCollected'],
    // The Overview's projected-vs-live band and paired bars. A billed figure moving is the
    // PROJECTED half of every pair there, and it rebuilds from the same lease schedule.
    ['portfolioBasis'],
    ['alerts'],
  ];
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

// One place that knows what goes stale when a PAYMENT moves — recorded, taken back, or
// re-filed onto another month.
//
// ⚠ IT IS NOT `settleBillingChange`, and the difference is the point. Recording a cheque
// changes who has SETTLED; it does not change what anybody was BILLED. Sending it through the
// billed-figure set refetches sixteen key families — tenant shares, lease rows, estimate
// ledgers, roll-ups, alerts — for a write that moved none of them, and on the Ledger that
// means waiting out a full property-roll rebuild before the box answers. MonthDetailPanel did
// exactly that until 2026-08-17, which is most of *"deleting anything on the app feels super
// slow"*.
//
// `invoices` is here because recording a payment can DRAFT the year's invoice if none exists
// (markMonthPaid → ensureInvoice), not because a figure on it moved.
export function settlePaymentChange(qc, { propertyId } = {}) {
  const keys = [
    propertyId ? ['propertyRentRoll', propertyId] : ['propertyRentRoll'],
    ['monthlyRent'],
    ['invoices'],
    ['payments'],
    // ⚠ THE OVERVIEW'S CASH FIGURES, MISSING HERE UNTIL 2026-08-18. A payment is the ONE
    // thing this set exists for and it is precisely what those two reads count — so
    // recording a cheque moved the Ledger and left the Overview quoting yesterday's figure
    // until something else happened to invalidate it. That is the drift-by-omission this
    // whole file exists to prevent, sitting in the file itself: `settleBillingChange`
    // carries both keys, and the fast path split off from it without them.
    ['portfolioCollected'],
    ['portfolioBasis'],
  ];
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

// One place that knows what goes stale when a lease's SCHEDULE is rewritten wholesale —
// anchoring a start date, or applying a new lease document over the old one. Those replace
// the rent steps, the renewal options and the abatement windows in one action, and all three
// render from their own per-lease keys that settleBillingChange deliberately does not cover
// (it covers the shared money screens; this is the lease's own page).
//
// Named rather than repeated because the omission has a long tail: the lease-review strip
// derives its "Option 1 has lapsed" warning from the renewal rows, so a stale ['renewals']
// key leaves the page warning about an option the new lease already replaced — a live
// contradiction between two panels a few inches apart.
export function settleLeaseScheduleChange(qc, leaseId) {
  for (const name of ['escalations', 'abatements', 'renewals']) {
    qc.invalidateQueries({ queryKey: leaseId ? [name, leaseId] : [name] });
  }
  // Three more that are keyed by something the caller doesn't hold, so they go by PREFIX:
  //   escalationsByProperty — prefetch.js seeds the property-level step cache
  //   extractionRaw         — keyed by lease_file_id; the lease page reads the document's
  //                           own AI read from it (rent_renegotiation_months and friends)
  //   leaseStatedEstimate   — same source, read by the Financials "stated on the lease" chip
  // The last two matter specifically for a REPLACED document: the row is updated in place, so
  // the key is unchanged while the content behind it is now a different lease's read.
  for (const name of ['escalationsByProperty', 'extractionRaw', 'leaseStatedEstimate']) {
    qc.invalidateQueries({ queryKey: [name] });
  }
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

// One place that knows what goes stale when a SERVICE CONTRACT changes — added, edited,
// replaced by a new document, or deleted.
//
// A NAMED set rather than a hand-rolled one. The rule this file exists for forbids a third
// hand-rolled list, not a third named one (settleLeaseScheduleChange is already exactly
// that): the failure mode is lists that drift by omission, and a named export has one
// definition to keep right. The list it replaces — ServiceContractsSection's inline
// invalidate() — never invalidated ['alerts'], so editing a contract's end date left the
// dashboard bell showing the OLD expiry until a hard reload.
//
// Called ALONGSIDE settleBillingChange, never instead of it: a contract's fee reaches a
// stored invoice through cam_total, so both sets apply. Deliberately not folded INTO
// settleBillingChange either — otherwise every rent edit anywhere would refetch every
// property's contract list.
export function settleContractChange(qc, propertyId) {
  const keys = [
    propertyId ? ['serviceContracts', propertyId] : ['serviceContracts'],
    // The dated fee steps (0091). Keyed by contract AND by property, so both go by prefix.
    ['contractEscalations'],
    // The derived CAM line item and the total it re-sums into.
    propertyId ? ['camLineItems', propertyId] : ['camLineItems'],
    propertyId ? ['expenseRecord', propertyId] : ['expenseRecord'],
    // The property's history log, and the contract's own saved copies.
    ['historyEvents'],
    ['documents', 'service_contract'],
    // Documents out for signature on this contract (0093). Keyed ['envelopes', <lease or
    // contract id>], so the prefix covers both homes — and it MUST be here: applying a
    // signed contract stamps the envelope's applied_at, which is the only thing that clears
    // the "read the signed contract" prompt and the dashboard's signature_apply alert.
    ['envelopes'],
  ];
  for (const queryKey of keys) qc.invalidateQueries({ queryKey });
}

export default settleBillingChange;
