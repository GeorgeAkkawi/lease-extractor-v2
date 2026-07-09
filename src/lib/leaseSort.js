// Leases-page sorting. Pure + dependency-light so it's unit-testable and shared by
// the page. The default (term ending, ascending) matches the historical behaviour
// (api.listLeases still applies byTermEnd, and property cards/Excel export keep it).
import { byTermEnd } from './leaseSearch';

// The sort modes offered in the Leases-page dropdown. `custom` is the drag order.
// `total_rent` and `psf` need per-lease figures the row already computes, passed in
// via `totals` ({ [leaseId]: { camTax, total } }) so the comparator stays pure.
export const LEASE_SORTS = [
  { key: 'term_end', label: 'Term ending' },
  { key: 'base_rent', label: 'Base rent' },
  { key: 'psf', label: '$/SF rate' },
  { key: 'total_rent', label: 'Total rent' },
  { key: 'address', label: 'Address' },
  { key: 'custom', label: 'Custom order' },
];

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const tieName = (a, b) => String(a?.tenant_name || '').localeCompare(String(b?.tenant_name || ''));

// The comparable value for a lease under `mode` (null = "no data", always sorts last).
function valueFor(mode, totals) {
  return {
    base_rent: (l) => num(l.base_rent),
    psf: (l) => {
      const br = num(l.base_rent);
      const sqft = num(l.square_footage);
      return br != null && sqft ? br / sqft : null;
    },
    total_rent: (l) => num(totals?.[l.id]?.total),
    address: (l) => (l.premises_address || '').trim() || null,
  }[mode];
}

// Order `leases` by the chosen mode + direction. Nulls/blanks always sort LAST
// regardless of direction (so "no data yet" rows never crowd the top when flipped
// to descending). `manualOrder` is the saved id array for `custom` (ids not in it
// are appended in the default term-end order). Never mutates the input array.
export function sortLeases(leases, { mode = 'term_end', dir = 'asc', manualOrder = [], totals = {} } = {}) {
  const list = [...(leases || [])];

  if (mode === 'custom') {
    const rank = new Map(manualOrder.map((id, i) => [id, i]));
    const known = list.filter((l) => rank.has(l.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const unknown = list.filter((l) => !rank.has(l.id)).sort(byTermEnd);
    return [...known, ...unknown]; // custom order is not direction-flipped
  }

  if (mode === 'term_end') {
    // byTermEnd is ascending with no-end-date last; desc reverses only the dated ones.
    const dated = list.filter((l) => l.lease_termination_date).sort(byTermEnd);
    const undated = list.filter((l) => !l.lease_termination_date).sort(tieName);
    const ordered = dir === 'desc' ? dated.reverse() : dated;
    return [...ordered, ...undated];
  }

  const getVal = valueFor(mode, totals);
  const withVal = [];
  const blank = [];
  for (const l of list) (getVal(l) == null ? blank : withVal).push(l);
  withVal.sort((a, b) => {
    const va = getVal(a);
    const vb = getVal(b);
    let c;
    if (mode === 'address') c = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });
    else c = va - vb;
    if (c === 0) return tieName(a, b);
    return dir === 'desc' ? -c : c;
  });
  blank.sort(tieName);
  return [...withVal, ...blank];
}
