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
export function rentRollover(leases, todayIso, years = 5) {
  const today = String(todayIso || '').slice(0, 10);
  const thisYear = Number(today.slice(0, 4));
  if (!(thisYear > 0)) return [];

  const buckets = new Map();          // key → { key, label, value, count, kind }
  const add = (key, label, kind, rent) => {
    const b = buckets.get(key) || { key, label, kind, value: 0, count: 0 };
    b.value += rent; b.count += 1;
    buckets.set(key, b);
  };

  (leases || []).forEach((l) => {
    if (l.is_active === false) return;               // parked / removed tenants aren't exposure
    const end = l.lease_termination_date ? String(l.lease_termination_date).slice(0, 10) : null;
    if (!end) return;                                // no term end → nothing to roll off
    const rent = num(l.base_rent);
    if (rent <= 0) return;
    if (end < today) { add('now', 'Now', 'now', rent); return; }
    const y = Number(end.slice(0, 4));
    if (!(y >= thisYear) || y > thisYear + years - 1) return;  // beyond the window we show
    add(String(y), String(y), 'year', rent);
  });

  const order = ['now', ...Array.from({ length: years }, (_, i) => String(thisYear + i))];
  return order.map((k) => buckets.get(k)).filter(Boolean);
}

// Revenue / expenses / NOI per property — the grouped bars, the same triad the History
// page charts across years. Expenses are summed from the three stored components rather
// than read from a total column, matching how HistoryPage computes them.
export function revenueExpensesNoi(properties, totalsByProp) {
  return (properties || [])
    .map((p) => {
      const t = totalsByProp?.[p.id];
      if (!t) return null;
      const revenue = num(t.total_revenue);
      const expenses = num(t.taxes_total) + num(t.cam_total) + num(t.roof_total);
      if (revenue === 0 && expenses === 0) return null;
      return { id: p.id, name: nameFor(p), Revenue: revenue, Expenses: expenses, NOI: num(t.noi) };
    })
    .filter(Boolean)
    .sort((a, b) => b.Revenue - a.Revenue);
}

// A long property name in a legend or axis tick pushes the chart out of shape; the
// tooltip still carries the full name.
export const shortName = (name, max = 18) => {
  const s = String(name || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
