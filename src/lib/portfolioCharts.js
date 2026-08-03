// Shapers for the Overview's "Portfolio at a glance" chart band.
//
// Pure and leaf-level on purpose: every figure comes from data the dashboard has
// ALREADY fetched (the search index + v_property_totals for the selected fiscal year),
// so the charts add zero network calls and can never disagree with the metric cards
// sitting above them — both read the same view rows.
//
// The palette is the app's own: olive (--accent), forest, and a chart gold in the same
// hue family as the --gold token (#94661B). The token itself is tuned for small type on
// ivory; as a large filled area it needs a touch more light, but only a touch — an
// earlier, brighter gold (#B98B3A) sat far above olive and forest in both lightness and
// saturation and read as the odd one out beside them.

// Chart-only series colours, shared with HistoryPage's trends chart so the two read
// as one visual language.
export const CHART_SERIES = {
  revenue: '#5C6B3C',   // olive — the app's accent
  expenses: '#9C7430',  // chart gold
  noi: '#2E4636',       // forest
  leased: '#5C6B3C',
  vacant: '#D8D2C3',    // warm paper-grey — reads as "nothing here", never as a figure
};

// The "so far this year" trio, drawn beside its full-year twin. SAME HUE, lighter tint —
// deliberately not a fourth/fifth/sixth colour: the pairing is the whole point, and two
// unrelated colours would read as six separate measures rather than three on two bases.
// Every tint is already in DONUT_PALETTE, so nothing new enters the app's palette.
export const CHART_SERIES_YTD = {
  collected: '#9AA77E',  // olive, lightened
  paid: '#C09A55',       // gold, lightened
  kept: '#6F8874',       // forest, lightened
};

// Ramp for the revenue donut: olive → forest → gold → their soft tints. Ordered so the
// biggest earner takes the deepest ink and the tail fades, which is how a reader's eye
// ranks slices without reading a single label.
export const DONUT_PALETTE = [
  '#5C6B3C', '#2E4636', '#9C7430', '#7C8B5A', '#4A6350',
  '#C09A55', '#9AA77E', '#6F8874', '#D6B77E', '#B9C0A4',
];

// Rollover ramp — warm at the near end, cooling into olive and forest as the years run
// out, so the shape reads before any label does.
//
// The near end deliberately does NOT use the danger red: a lease reaching its end date is
// a scheduled fact, not a fault, and red said "something is broken here". It takes the
// app's own --gold (#94661B) instead — gold's job throughout Amlak is "look here", which
// is exactly the weight this bucket wants.
export const ROLLOVER_RAMP = ['#94661B', '#B08A46', '#9A9152', '#7C8B5A', '#5C6B3C', '#2E4636'];

// $1.2k / $340 — axis + label formatter, identical to the one HistoryPage's chart uses.
export const kfmt = (v) => (v == null || isNaN(v) ? '' : Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`);

const num = (n) => Number(n) || 0;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Property name lookup that survives a property the totals map doesn't cover.
const nameFor = (p) => p?.name || 'Untitled property';

// Annual rent roll per property, biggest first — the donut.
// Zero-revenue properties are dropped: a 0% slice is invisible but still claims a
// legend entry and a colour, which makes the chart harder to read, not richer.
export function revenueByProperty(properties, totalsByProp) {
  const out = (properties || [])
    .map((p) => ({ id: p.id, name: nameFor(p), value: num(totalsByProp?.[p.id]?.total_revenue) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  return out;
}

// How much of each property's space is leased — one filled track per property, not a
// chart. The question is a RATIO inside each property, and stacked bars answered a
// different one (whose building is bigger), with a Y axis reading "10k" of nothing named.
//
// Only properties with a building size entered can answer this honestly: without one,
// v_property_totals coalesces building_sf to the leased total, so vacancy would always
// read zero. Those properties are left out rather than shown as fully leased.
//
// Sorted by the empty space, most first — the vacancy is the thing worth looking at.
export function occupancyByProperty(properties, totalsByProp) {
  return (properties || [])
    .map((p) => {
      const building = num(p.building_sf);
      if (!(building > 0)) return null;
      const leased = Math.min(num(totalsByProp?.[p.id]?.total_sf), building);
      return {
        id: p.id, name: nameFor(p), building, leased,
        vacant: Math.max(0, building - leased),
        pct: Math.round((leased / building) * 100),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.vacant - a.vacant || b.building - a.building);
}

// The headline over those tracks: the portfolio's own leased share, summed from the same
// rows so the figure can never disagree with the bars beneath it. null when there is
// nothing to measure against.
export function portfolioOccupancy(rows) {
  const building = (rows || []).reduce((s, r) => s + num(r.building), 0);
  if (!(building > 0)) return null;
  const leased = (rows || []).reduce((s, r) => s + num(r.leased), 0);
  return { building, leased, vacant: Math.max(0, building - leased), pct: Math.round((leased / building) * 100) };
}

// Rollover exposure — how much annual rent comes up for renewal, and when. The one
// measure a commercial landlord watches that nothing else on the Overview touches: the
// other panels are all about today, this is about what's coming.
//
// A leading "Now" bucket carries active leases already past their term end — rent sitting
// on holdover is at risk today, and nothing else says so on this page.
//
// Uses base_rent, the rent in effect today (the escalation engine keeps that column
// live), projected forward — NOT the year-aware effective_rent the donut and NOI panels
// read. The two answer different questions; the panel's caption says which this is.
// Each bucket also carries the LEASES inside it — name, rent and end date, biggest rent
// first — so hovering a bar answers the question the bar itself raises ("which ones?")
// without a trip to the Leases page.
export function rentRollover(leases, todayIso, years = 5) {
  const today = String(todayIso || '').slice(0, 10);
  const thisYear = Number(today.slice(0, 4));
  if (!(thisYear > 0)) return [];

  const buckets = new Map();          // key → { key, label, value, count, kind, leases[] }
  const add = (key, label, kind, lease) => {
    const b = buckets.get(key) || { key, label, kind, value: 0, count: 0, leases: [] };
    b.value += lease.rent; b.count += 1;
    b.leases.push(lease);
    buckets.set(key, b);
  };

  (leases || []).forEach((l) => {
    if (l.is_active === false) return;               // parked / removed tenants aren't exposure
    const end = l.lease_termination_date ? String(l.lease_termination_date).slice(0, 10) : null;
    if (!end) return;                                // no term end → nothing to roll off
    const rent = num(l.base_rent);
    if (rent <= 0) return;
    const row = { id: l.id, name: l.tenant_name || 'Untitled tenant', rent, end };
    if (end < today) { add('now', 'Now', 'now', row); return; }
    const y = Number(end.slice(0, 4));
    if (!(y >= thisYear) || y > thisYear + years - 1) return;  // beyond the window we show
    add(String(y), String(y), 'year', row);
  });

  const order = ['now', ...Array.from({ length: years }, (_, i) => String(thisYear + i))];
  return order
    .map((k) => buckets.get(k))
    .filter(Boolean)
    .map((b) => ({ ...b, leases: b.leases.sort((a, c) => c.rent - a.rent || a.name.localeCompare(c.name)) }));
}

// Who occupies a building — one slice per tenant, sized by square footage, plus the
// space nobody is renting. The donut on each property card.
//
// The denominator MIRRORS the SQL rule the bills are split by:
// `coalesce(nullif(p.building_sf,0), pt.total_sf)` (v_tenant_shares, migration 0065) —
// so a slice's percentage is the same share the tenant is charged CAM and tax on, and
// the card can never disagree with the Financials breakdown. With no building size
// entered, the split falls back to leased SF and there is no vacant slice to draw
// (nothing is known to be empty), which is exactly what occupancyByProperty does.
//
// Counts EVERY lease including is_active === false: an outdated / needs-extension
// tenant still occupies the space and still owes rent until the landlord removes them,
// matching the card's own tenant count and the Leases page (PropertiesPage.js:92).
// A lease with no square footage can't be sized, so it takes no slice — it is still
// counted as a tenant everywhere else on the card.
export function tenantMix(property, leases) {
  const rows = (leases || [])
    .map((l) => ({
      id: l.id,
      name: l.tenant_name || 'Untitled tenant',
      sf: num(l.square_footage),
      rent: num(l.base_rent),
      kind: 'tenant',
    }))
    .filter((r) => r.sf > 0)
    .sort((a, b) => b.sf - a.sf || a.name.localeCompare(b.name));

  const leased = rows.reduce((s, r) => s + r.sf, 0);
  const building = num(property?.building_sf);
  const denom = building > 0 ? building : leased;
  if (!(denom > 0)) return [];

  const vacant = building > 0 ? Math.max(0, building - leased) : 0;
  const out = vacant > 0
    ? [...rows, { id: '__vacant__', name: 'Vacant space', sf: vacant, rent: 0, kind: 'vacant' }]
    : rows;

  return out.map((r) => ({
    ...r,
    pct: r.sf / denom,
    // Rent per square foot, the figure George asked to see on hover. null rather than
    // Infinity when a lease has rent but no size — the filter above already drops those,
    // but the guard keeps the shaper honest if it's ever fed a raw row.
    psf: r.kind === 'tenant' && r.sf > 0 ? r.rent / r.sf : null,
  }));
}

// Revenue / expenses / NOI per property — the grouped bars, the same triad the History
// page charts across years. Expenses are summed from the three stored components rather
// than read from a total column, matching how HistoryPage computes them.
//
// Those three components are the ACTUAL figures entered on the property's Expense entry
// (expense_records.taxes_total / cam_total / roof_total) — never the CAM & tax ESTIMATES
// billed to tenants, which live per-lease on est_cam_annual / est_tax_annual and are a
// different quantity entirely (they're usually higher; the gap IS the year-end true-up).
// They're carried onto each row so the tooltip can show its working, because a bar
// labelled only "Expenses" can't tell the landlord which of the two it is.
// ⚠ THE SECOND BASIS, and the whole reason the panel needs explaining. `ledgerByProp`
// (listLedgerYtdByProperty) adds a "so far this year" twin to each of the three:
//
//   Revenue  (on paper, whole year)  ↔  Collected  (money in, so far)
//   Expenses (entered, whole year)   ↔  Paid       (expense lines dated on/before today)
//   NOI      (revenue − expenses)    ↔  Kept       (collected − paid)
//
// The two are NOT the same measure at two points in time, and pretending otherwise is the
// trap here:
//   • Collected is ALL-IN — it carries the CAM & tax the tenants reimburse — while
//     Revenue is `total_revenue` = Σ effective_rent, contract BASE RENT only. So Kept can
//     legitimately read ABOVE NOI (round 14's flag: v_property_totals.noi subtracts the
//     whole expense and counts none of the reimbursement). The panel says so.
//   • Paid counts only DATED expense lines. Whatever the year's stored totals hold beyond
//     the dated ones is returned as `expensesUndated` so the caller can state it rather
//     than let Kept quietly read as profit. Nothing is spread evenly across the months.
// `hasYtd` is per-property (did anything actually move?) so the caller can hide the trio
// portfolio-wide when it would draw three empty bars.
export function revenueExpensesNoi(properties, totalsByProp, ledgerByProp = null) {
  return (properties || [])
    .map((p) => {
      const t = totalsByProp?.[p.id];
      if (!t) return null;
      const taxes = num(t.taxes_total);
      const cam = num(t.cam_total);
      const roof = num(t.roof_total);
      const revenue = num(t.total_revenue);
      const expenses = taxes + cam + roof;
      if (revenue === 0 && expenses === 0) return null;
      const row = { id: p.id, name: nameFor(p), Revenue: revenue, Expenses: expenses, NOI: num(t.noi), taxes, cam, roof };
      if (ledgerByProp) {
        const y = ledgerByProp[p.id] || {};
        const collected = num(y.collected);
        const paid = num(y.paidToDate);
        const later = num(y.datedLater);
        row.Collected = collected;
        row.Paid = paid;
        row.Kept = round2(collected - paid);
        row.billedYtd = num(y.billed);
        row.expensesLater = later;
        // Everything the stored total holds that carries no usable date yet — undated
        // lines AND an un-itemized flat kind, which has no line to date at all.
        row.expensesUndated = Math.max(0, round2(expenses - paid - later));
        row.hasYtd = collected > 0 || paid > 0;
      }
      return row;
    })
    .filter(Boolean)
    .sort((a, b) => b.Revenue - a.Revenue);
}

// Is there a "so far" story to tell at all? False when nothing has been collected and no
// expense carries a payment date — three flat zero bars per property would say nothing
// and make the three that matter harder to read.
export const hasYtdBars = (rows) => (rows || []).some((r) => r.hasYtd);

// A long property name in a legend or axis tick pushes the chart out of shape; the
// tooltip still carries the full name.
export const shortName = (name, max = 18) => {
  const s = String(name || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
