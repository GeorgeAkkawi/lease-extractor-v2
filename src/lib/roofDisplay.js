// Whether a property's screens OFFER roof as its own expense category (0097).
//
// George, 2026-08-06: *"some people might just throw it in a cam expense if repairs ever
// happen to it but others might want it separate."*
//
// ⚠ NOTHING HERE DECIDES WHAT ANYONE IS BILLED. `v_tenant_shares.roof_amt`, `billedComponents`,
// `componentizeSchedule` and `draft-invoice` never see this flag — a tenant marked
// roof-responsible is charged for the roof whether or not the landlord has the box ticked.
// This module answers one question and only one: does the screen show roof here.
//
// Dependency-free on purpose, the same reason `isoDate.js` is: a rule this small gets called
// from a page, a component and a pure lib, and none of them should have to reach into `api.js`
// to ask it.
//
// ⚠ `!== false`, NEVER `=== true` — this is the load-bearing line in the file. A property row
// read before 0097 shipped, a demo fixture that never carried the column, an optimistic object
// built client-side: all of them have `roof_separate` undefined, and every one must read as ON,
// matching the column's own `not null default true`. Written the other way round, every
// existing property would quietly stop offering roof the moment this deployed.
export const roofOffered = (property) => property?.roof_separate !== false;

// The whole rule, in one call.
//
// `hasFigures` is the half that makes the flag safe to give a landlord at all: OFF hides roof
// only where roof is EMPTY. Anywhere it already carries a figure — a year with a roof total, a
// lease still marked roof-responsible, a tenant with a roof share — the surface renders whatever
// the checkbox says, because the alternative is money moving on a screen that stopped mentioning
// it. Each caller supplies the evidence it can see from data it ALREADY selects:
//
//   the property page   roof_total > 0 || any share roof_responsible
//   a lease's page      roof_responsible || est_roof_annual != null
//   the breakdown       any share with roof_responsible || roof_amt > 0
//
// ⚠ THE "ANY LEASE IS RESPONSIBLE" HALF COMES FROM v_tenant_shares, NOT v_property_totals.
// 0049 computes resp_sf, but inside a CTE that is never selected out — `totals.resp_sf` is
// undefined live (PostgREST: 42703), so a gate written against it reads permanently false and
// the property page silently loses the second half of this rule. Without that half, a building
// switched off while empty keeps the roof box hidden after an addendum marks a lease
// roof-responsible, leaving a tenant on the hook with nowhere to enter the cost.
export const showRoof = (property, hasFigures) => roofOffered(property) || !!hasFigures;
