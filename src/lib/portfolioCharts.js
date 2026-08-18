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

// The LIVE ink for each measure — drawn beside the projected bar it belongs to. Each is
// THE SAME HUE AS ITS TWIN, one tint lighter, and deliberately not a new colour: the
// pairing IS the point, and an unrelated hue would read as an unrelated measure rather
// than the same one, so far. Both are already in DONUT_PALETTE, so nothing new enters the
// app's palette.
export const CHART_LIVE = {
  revenue: '#9AA77E',   // olive, lighter
  expenses: '#C09A55',  // chart gold, lighter
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
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

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
// ⚠ THE FOURTH BAR, and the one thing about it that must be said out loud. `collectedByProp`
// (listCollectedByProperty) adds `Collected` — the rent actually received against this
// year's invoices — beside the Revenue bar it belongs to.
//
// It is NOT a fraction of Revenue, and treating it as one is the trap:
//   • Collected is ALL-IN — it carries the CAM & tax the tenants reimburse — while
//     Revenue is `total_revenue` = Σ effective_rent, contract BASE RENT only. So a
//     property collecting well can legitimately read ABOVE its Revenue bar (the same
//     asymmetry as round 14's NOI flag: v_property_totals counts none of the
//     reimbursement). The panel states the reason rather than clamping the figure.
//   • `billedYtd` rides along so the tooltip can say what it is a share OF — the invoices
//     actually issued — which is the honest denominator.
// `hasCollected` is per-property so the caller can hide the bar portfolio-wide rather than
// draw an empty one against every property.
export function revenueExpensesNoi(properties, totalsByProp, collectedByProp = null) {
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
      if (collectedByProp) {
        const y = collectedByProp[p.id] || {};
        row.Collected = num(y.collected);
        row.billedYtd = num(y.billed);
        row.hasCollected = row.Collected > 0;
      }
      return row;
    })
    .filter(Boolean)
    .sort((a, b) => b.Revenue - a.Revenue);
}

// Is there anything collected to draw at all? False when not a dollar has come in — a flat
// zero bar against every property would say nothing and cost the other three their width.
export const hasCollectedBars = (rows) => (rows || []).some((r) => r.hasCollected);

// ---- Projected vs live (2026-08-18) ----------------------------------------------
// George: *"weve built thi software around projected but there should be a live counter as
// well … and any over or undercharges only counts towards live count."*
//
// ⚠ THE POINT IS THAT THE TWO SIDES ARE THE SAME MEASURE, which `revenueExpensesNoi` above
// could not manage: its Revenue is `total_revenue` (base rent only, applied steps only) and
// its Collected is all-in cash, so the panel had to print a paragraph explaining that the
// second could legitimately read above the first. Here both sides of each pair count the
// same dollars, and the gap between them is the whole message.
//
//   Projected revenue  — `listBasisByProperty`: what the leases contract for the year,
//                        all-in, twelve months, INCLUDING a rent step dated later this year
//                        that has not been swept into base_rent yet.
//   Live revenue       — cash the Ledger says arrived, all-in, with an unanswered
//                        over-payment withheld until the landlord says what it is.
//   Projected expenses — `taxes_total + cam_total + roof_total`, the year's costs as entered.
//   Live expenses      — the itemized lines carrying a payment date on or before today.
//
// ⚠ `undatedExpenses` IS A REAL FIGURE, NOT A ROUNDING BUCKET, and it is the one thing that
// can make Live expenses lie. `paid_date` is nullable and never backfilled (0074): a kind
// entered as one flat total has no lines at all, and a contract-derived CAM row never carries
// a day. Without it stated, a year with undated costs reads as though it had been cheap. It
// is carried on every row so the band can name it and link to where it gets fixed — the same
// discipline as the workbook's "No date" column (CLAUDE.md §3).
//
// A property the totals view doesn't cover is dropped rather than fabricated as zeros, and a
// property with nothing on either side of either pair is dropped too — an empty row costs the
// others their width and says nothing.
export function projectedVsLive(properties, totalsByProp, basisByProp = null) {
  return (properties || [])
    .map((p) => {
      const t = totalsByProp?.[p.id];
      if (!t) return null;
      const b = basisByProp?.[p.id] || null;
      const taxes = num(t.taxes_total);
      const cam = num(t.cam_total);
      const roof = num(t.roof_total);
      const projectedExpenses = round2(taxes + cam + roof);
      const projectedRevenue = round2(num(b?.projectedRevenue));
      const liveRevenue = round2(num(b?.liveRevenue));
      const liveExpenses = round2(num(b?.spentToDate));
      if (projectedRevenue === 0 && projectedExpenses === 0 && liveRevenue === 0 && liveExpenses === 0) return null;
      return {
        id: p.id,
        name: nameFor(p),
        'Projected revenue': projectedRevenue,
        'Live revenue': liveRevenue,
        'Projected expenses': projectedExpenses,
        'Live expenses': liveExpenses,
        projectedNet: round2(projectedRevenue - projectedExpenses),
        liveNet: round2(liveRevenue - liveExpenses),
        // Entered costs with no payment date — in Projected, in no Live figure, and named
        // rather than dropped. Clamped at zero: itemized lines can briefly exceed a stored
        // total, and a negative "undated" would be a nonsense figure on a panel.
        undatedExpenses: Math.max(0, round2(projectedExpenses - num(b?.spentDated))),
        // Cash beyond what a month billed, still waiting on the landlord's answer on the
        // Ledger. In NO figure here — that is the whole point of it.
        unapplied: round2(num(b?.unapplied)),
        // The expense components, so the tooltip can show its working — a bar labelled only
        // "Expenses" can't tell a landlord which of the two kinds of expense it is.
        taxes, cam, roof,
        // Quoted on hover so this panel and the property pages stay reconcilable. NOI is not
        // a smaller `projectedNet`: it counts base rent only, where this counts the CAM & tax
        // tenants reimburse as well.
        noi: num(t.noi),
        loading: !b,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b['Projected revenue'] - a['Projected revenue'] || a.name.localeCompare(b.name));
}

// The three headline pairs the band prints, SUMMED FROM THE ROUNDED property rows so the
// band can never sit a cent away from the bars beneath it — the same rule `consolidate`
// keeps for the workbook's Summary sheet.
//
// `share` is live over projected, and it is null rather than 0 when nothing is projected:
// "0% collected" against a year that bills nothing is a fabricated accusation, and a track
// drawn from it would be a filled bar shaped like a finding.
export function portfolioBasis(rows = []) {
  const sum = (key) => round2((rows || []).reduce((s, r) => s + num(r[key]), 0));
  const pair = (projected, live) => ({
    projected, live,
    delta: round2(live - projected),
    share: projected > 0 ? live / projected : null,
  });
  const revenue = pair(sum('Projected revenue'), sum('Live revenue'));
  const expenses = pair(sum('Projected expenses'), sum('Live expenses'));
  return {
    revenue,
    expenses,
    // What's left, on each basis. ⚠ NOT NOI — this revenue is all-in and NOI's is base rent
    // only, which is the same gap the property page's "What actually stayed" strip exists to
    // explain. The band says so rather than letting two bottom lines sit unreconciled.
    net: pair(round2(revenue.projected - expenses.projected), round2(revenue.live - expenses.live)),
    undatedExpenses: sum('undatedExpenses'),
    unapplied: sum('unapplied'),
    loading: (rows || []).some((r) => r.loading),
  };
}

// A long property name in a legend or axis tick pushes the chart out of shape; the
// tooltip still carries the full name.
export const shortName = (name, max = 18) => {
  const s = String(name || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
