// Slice 7c — the package you hand a lender.
//
// The expensive failures here are not formatting. They are:
//   ① UNDERSTATING NOI. `v_property_totals.noi` takes the WHOLE expense out and counts
//      the tenant reimbursement nowhere. It is neither the gross view nor the net view —
//      and those two are the same number, which is what proves the third one wrong.
//   ② COUNTING A GROSS TENANT'S REIMBURSEMENT TWICE. The view computes a pro-rata share
//      for every lease including a gross one, whose reimbursement is already inside the
//      flat rent.
//   ③ MEASURING ROLLOVER IN RENT ALONE. A departing tenant takes their reimbursement too,
//      and the expense stays — so rent alone understates the exposure.
//   ④ REPORTING A RATIO WITH AN UNKNOWN DENOMINATOR. Amlak does not hold the loans.
//
// These are pinned in both directions.
import { describe, it, expect } from 'vitest';
import {
  underwriteProperty, rolloverSchedule, atRiskWithin, coverage,
  notInPackage, lenderFlags, monthsBetween, buildLenderPackage, ADJUSTMENT_NOTE,
} from '../lenderPackage';
import { currentYear } from '../format';

const Y = 2026;
const TODAY = '2026-07-15';

// A property that makes every trap visible at once:
//   • Anchor Bakery — net lease, well inside its term
//   • Corner Cleaners — GROSS lease, reaching term end inside twelve months
//   • Old Diner — already past its end date, holding over
//   • 1,000 SF vacant
const PROPERTY = { id: 'p1', name: 'Midtown Row', address: '9 Market St' };
const TOTALS = { building_sf: 10000, noi: 134000 }; // 184,000 rent − 50,000 expenses
const EXPENSE = { taxes_total: 30000, cam_total: 20000, roof_total: 0 };
const ITEMS = [
  { kind: 'tax', label: 'County taxes', amount: 30000, paid_date: '2026-03-11', billable: true },
  { kind: 'cam', label: 'Landscaping', amount: 12000, paid_date: '2026-05-02', billable: true },
  { kind: 'cam', label: 'Snow removal', amount: 8000, paid_date: null, billable: true },
];
const SHARES = [
  {
    lease_id: 'L-A', tenant_name: 'Anchor Bakery', premises_address: 'Unit 1', square_footage: 6000,
    base_rent: 120000, cam_amount: 12000, tax_amount: 18000, roof_amt: 0, lease_type: null,
    lease_start: '2023-07-01', lease_termination_date: '2028-06-30',
  },
  {
    lease_id: 'L-B', tenant_name: 'Corner Cleaners', premises_address: 'Unit 2', square_footage: 2000,
    base_rent: 40000, cam_amount: 4000, tax_amount: 6000, roof_amt: 0, lease_type: 'gross',
    lease_start: '2021-12-01', lease_termination_date: '2026-11-30',
  },
  {
    lease_id: 'L-C', tenant_name: 'Old Diner', premises_address: 'Unit 3', square_footage: 1000,
    base_rent: 24000, cam_amount: 2000, tax_amount: 3000, roof_amt: 0, lease_type: null,
    lease_start: '2021-02-01', lease_termination_date: '2026-01-31',
  },
];
const OPTIONS = [
  { lease_id: 'L-B', status: 'pending', notice_by_date: '2026-08-31', term_months: 60 },
  // Belongs to a term that ended — round 8's lapse rule, so it is not a live mitigant.
  { lease_id: 'L-C', status: 'pending', notice_by_date: '2025-07-31', term_months: 60 },
];

const shape = (over = {}) => underwriteProperty({
  property: PROPERTY, totals: TOTALS, expense: EXPENSE, items: ITEMS, shares: SHARES,
  otherIncome: [], invoices: [], payments: [], options: OPTIONS, year: Y, todayIso: TODAY, ...over,
});

describe('the NOI a lender underwrites', () => {
  // ⚠ THE HEADLINE. Income is gross on both sides; the app's own NOI is short by exactly
  // the reimbursement, because it subtracts the whole expense and counts none of it back.
  it('counts the reimbursement as income and takes the expense out in full', () => {
    const p = shape();
    expect(p.income.inPlaceRent).toBe(184000);
    expect(p.income.reimbursements).toBe(35000);
    expect(p.income.egi).toBe(219000);
    expect(p.opex).toBe(50000);
    expect(p.noi).toBe(169000);
    // And explicitly NOT the figure the Financials page shows.
    expect(p.appNoi).toBe(134000);
    expect(p.noi).not.toBe(134000);
    expect(p.noiGap).toBe(35000);
    expect(p.noiGap).toBe(p.income.reimbursements); // the gap IS the reimbursement
  });

  // ⚠ THE GROSS-LEASE TRAP, and it is live (Card Pop, Joliet). The view computes a share
  // for a gross lease too; adding it would count the same dollars twice.
  it('never adds a gross tenant’s reimbursement — it is already inside the flat rent', () => {
    const p = shape();
    const gross = p.rentRoll.find((r) => r.tenant === 'Corner Cleaners');
    expect(gross.gross).toBe(true);
    expect(gross.reimbursement).toBe(0);
    expect(gross.reimbursementInsideRent).toBe(10000);
    expect(gross.total).toBe(40000);
    // Reported, never added: 35,000 counted, 10,000 stated separately.
    expect(p.income.grossInsideRent).toBe(10000);
    expect(p.income.egi).toBe(219000);
    expect(p.income.egi).not.toBe(229000);
  });

  it('ties the rent roll to the income line to the dollar', () => {
    const p = shape();
    const rolled = p.rentRoll.reduce((s, r) => s + r.rent, 0);
    expect(rolled).toBe(p.income.inPlaceRent);
    const reimb = p.rentRoll.reduce((s, r) => s + r.reimbursement, 0);
    expect(reimb).toBe(p.income.reimbursements);
  });

  // Contract rent, not invoiced rent: an invoice carries the CAM ESTIMATE and can be
  // stale or missing entirely. Billed rides along as a cross-check only.
  it('underwrites contract rent, and carries billed rent as a cross-check', () => {
    const p = shape({ invoices: [{ id: 'i1', year: Y, status: 'sent', total_amount: 900000 }] });
    expect(p.income.billed).toBe(900000);
    expect(p.income.inPlaceRent).toBe(184000);
    expect(p.income.egi).toBe(219000); // the wild invoice does not touch it
  });

  it('reports occupancy and the vacant space', () => {
    const p = shape();
    expect(p.leasedSf).toBe(9000);
    expect(p.vacantSf).toBe(1000);
    expect(p.occupancy).toBeCloseTo(0.9, 6);
  });

  // Weighted by rent, and a tenant already holding over contributes 0 — their term is
  // up, not owed backwards.
  it('weights the average lease term by rent and floors a holdover at zero', () => {
    expect(shape().walt).toBe(1.32);
  });
});

describe('what can honestly be placed in a month', () => {
  it('never spreads an undated expense across twelve months', () => {
    const p = shape();
    expect(p.expenseByMonth[2]).toBe(30000); // March taxes
    expect(p.expenseByMonth[4]).toBe(12000); // May landscaping
    expect(p.expenseUndated).toBe(8000);     // snow removal — no date
    expect(p.expenseByMonth.filter((v) => v > 0)).toHaveLength(2);
    expect(p.datedLines).toBe(2);
    expect(p.lineCount).toBe(3);
  });

  // A kind with a total and no lines of its own is a flat hand-typed figure with no day
  // at all — Pershing's $127,000 of taxes, live.
  it('treats an un-itemized kind as undated rather than dropping it', () => {
    const p = shape({ items: [], expense: { taxes_total: 127000, cam_total: 0, roof_total: 0 } });
    expect(p.expenseUndated).toBe(127000);
    expect(p.expenseByMonth.every((v) => v === 0)).toBe(true);
  });

  it('places collections by the month the money actually arrived', () => {
    const p = shape({ payments: [
      { amount: 5000, paid_date: '2026-02-04' },
      { amount: 5000, paid_date: '2026-02-27' },
      { amount: 7000, paid_date: '2025-12-30' }, // banked in a different year
    ] });
    expect(p.collectedByMonth[1]).toBe(10000);
    expect(p.collectedTotal).toBe(10000);
    expect(p.collectedUndated).toBe(7000);
  });
});

describe('when the rent rolls off', () => {
  // ⚠ THE ARITHMETIC ONLY AMLAK CAN DO: rent PLUS reimbursement, because the expense stays.
  it('measures exposure as rent plus reimbursement, never rent alone', () => {
    const risk = atRiskWithin(shape().rentRoll, { todayIso: TODAY, months: 12 });
    expect(risk.rent).toBe(64000);   // 40,000 gross + 24,000 diner
    expect(risk.total).toBe(69000);  // + the diner's 5,000 reimbursement
    expect(risk.total).not.toBe(risk.rent);
  });

  it('treats a holdover as exposed today, at any horizon', () => {
    const rows = shape().rentRoll;
    expect(atRiskWithin(rows, { todayIso: TODAY, months: 1 }).leases.map((r) => r.tenant)).toEqual(['Old Diner']);
    const diner = rows.find((r) => r.tenant === 'Old Diner');
    expect(diner.holdover).toBe(true);
    expect(diner.monthsLeft).toBeLessThan(0);
  });

  it('buckets by year, with holdovers first, and sums to the rent roll', () => {
    const roll = rolloverSchedule(shape().rentRoll, { todayIso: TODAY });
    expect(roll.buckets.map((b) => b.key)).toEqual(['holdover', '2026', '2028']);
    expect(roll.buckets[0].atRisk).toBe(29000);
    expect(roll.buckets[1].atRisk).toBe(40000);
    expect(roll.buckets.reduce((s, b) => s + b.rent, 0)).toBe(roll.totalRent);
    expect(roll.totalRent).toBe(184000);
  });

  // A lease with no term end is a gap in the record, not a lease that never ends.
  it('counts a lease with no end date rather than bucketing it', () => {
    const rows = [...shape().rentRoll, { tenant: 'No Papers', rent: 9000, reimbursement: 0, total: 9000, end: null, holdover: false, monthsLeft: null }];
    const roll = rolloverSchedule(rows, { todayIso: TODAY });
    expect(roll.undated.map((r) => r.tenant)).toEqual(['No Papers']);
    expect(roll.buckets.reduce((s, b) => s + b.rent, 0)).toBe(184000);
  });

  // An unexercised option is a mitigant, never a discount — and a lapsed one is neither.
  it('names a live renewal option and ignores a lapsed one', () => {
    const rows = shape().rentRoll;
    expect(rows.find((r) => r.tenant === 'Corner Cleaners').optionsPending).toBe(1);
    expect(rows.find((r) => r.tenant === 'Corner Cleaners').noticeBy).toBe('2026-08-31');
    const diner = rows.find((r) => r.tenant === 'Old Diner');
    expect(diner.optionsPending).toBe(0);
    expect(diner.optionsLapsed).toBe(1);
    const risk = atRiskWithin(rows, { todayIso: TODAY, months: 12 });
    expect(risk.withOption).toBe(1);
    expect(risk.nextNotice).toBe('2026-08-31');
  });
});

describe('coverage', () => {
  const base = { egi: 219000, opex: 50000, atRisk: 69000, buildingSf: 10000 };

  // ⚠ A ratio with an unknown denominator is not a small ratio; it is not a ratio.
  it('refuses to state a ratio with no debt service — null, never 0 and never ∞', () => {
    const c = coverage(base);
    expect(c.debtService).toBeNull();
    expect(c.now.dscr).toBeNull();
    expect(c.down.dscr).toBeNull();
    expect(c.headroom).toBeNull();
    expect(c.now.noi).toBe(169000); // everything above the ratio still computes
  });

  it('computes today’s ratio and the one if the rollover walks', () => {
    const c = coverage({ ...base, debtService: 100000, mgmtPct: 4, reservePsf: 0.2 });
    expect(c.now.mgmtFee).toBe(8760);
    expect(c.now.reserve).toBe(2000);
    expect(c.now.noi).toBe(158240);
    expect(c.now.dscr).toBe(1.58);
    // The downside: income falls, the EXPENSE STAYS (that is what makes vacancy
    // expensive on a net lease), the fee follows the income, the building does not shrink.
    expect(c.down.egi).toBe(150000);
    expect(c.down.opex).toBe(50000);
    expect(c.down.mgmtFee).toBe(6000);
    expect(c.down.reserve).toBe(2000);
    expect(c.down.noi).toBe(92000);
    expect(c.down.dscr).toBe(0.92);
    expect(c.headroom).toBe(58240);
  });

  it('reports the unadjusted NOI when no lender assumptions are given, and says so', () => {
    const c = coverage({ ...base, debtService: 100000 });
    expect(c.adjusted).toBe(false);
    expect(c.now.noi).toBe(169000);
    expect(c.now.dscr).toBe(1.69);
    expect(ADJUSTMENT_NOTE).toMatch(/higher than the one the lender uses/);
  });
});

describe('what is deliberately absent', () => {
  // Round 6's rule, fourth application. A lender who cannot tell a careful export from
  // one that omitted the debt has to assume the worst.
  it('always names the missing debt, whatever else is on file', () => {
    const groups = notInPackage({ properties: [], unplaced: { count: 0, total: 0 } });
    expect(groups.map((g) => g.key)).toContain('debt');
    expect(groups.find((g) => g.key === 'debt').why).toMatch(/not saved/);
  });

  it('names each property with no expenses entered', () => {
    const groups = notInPackage({
      properties: [{ name: 'Joliet', expensesEntered: false }, { name: 'Pershing Plaza', expensesEntered: true }],
      unplaced: { count: 0, total: 0 },
    });
    const g = groups.find((x) => x.key === 'noExpenses');
    expect(g.names).toEqual(['Joliet']);
    expect(g.why).toMatch(/not a real NOI/);
  });

  it('leaves out an empty group rather than printing a zero', () => {
    const groups = notInPackage({ properties: [], unplaced: { count: 0, total: 0 } });
    expect(groups.map((g) => g.key)).not.toContain('unplaced');
  });
});

describe('the pre-flight', () => {
  const pkg = (over = {}) => ({ year: Y, properties: [shape()], ...over });

  it('flags a property with no expenses, and does not when they are entered', () => {
    const bare = underwriteProperty({ property: PROPERTY, totals: TOTALS, expense: {}, items: [], shares: SHARES, year: Y, todayIso: TODAY });
    expect(bare.expensesEntered).toBe(false);
    expect(lenderFlags(pkg({ properties: [bare] }), coverage({})).map((f) => f.key)).toContain('noExpenses');
    expect(lenderFlags(pkg(), coverage({ debtService: 1 })).map((f) => f.key)).not.toContain('noExpenses');
  });

  it('flags the missing debt service and the missing lender adjustments', () => {
    const keys = lenderFlags(pkg(), coverage({ egi: 1, opex: 0 })).map((f) => f.key);
    expect(keys).toContain('noDebt');
    expect(keys).toContain('noAdjust');
  });

  it('flags undated expenses only when nothing at all is dated', () => {
    expect(lenderFlags(pkg(), coverage({})).map((f) => f.key)).not.toContain('undated');
    const undated = shape({ items: ITEMS.map((i) => ({ ...i, paid_date: null })) });
    expect(lenderFlags(pkg({ properties: [undated] }), coverage({})).map((f) => f.key)).toContain('undated');
  });

  it('names the holdover tenant', () => {
    const f = lenderFlags(pkg(), coverage({})).find((x) => x.key === 'holdover');
    expect(f.text).toMatch(/Old Diner is holding over/);
  });

  // Seen on screen: the uncategorised figure printed as a bare "6000", which on a
  // lender-facing page reads as a count rather than money. Every dollar in these flags
  // is currency-formatted.
  it('states the uncategorised figure as money, not a bare number', () => {
    // A CAM label the registry has no default for — the one genuinely ambiguous section,
    // and the state the demo's "Security" bucket is in.
    const un = shape({ items: [...ITEMS, { kind: 'cam', label: 'Concierge desk', amount: 6000, paid_date: null, billable: true }] });
    const f = lenderFlags(pkg({ properties: [un] }), coverage({})).find((x) => x.key === 'uncategorized');
    expect(f).toBeTruthy();
    expect(f.text).toMatch(/^\$[\d,]+\.\d{2} of expenses/);
  });
});

describe('month arithmetic', () => {
  it('counts whole months and goes negative once the date has passed', () => {
    expect(monthsBetween('2026-07-15', '2028-06-30')).toBe(23);
    expect(monthsBetween('2026-07-15', '2026-11-30')).toBe(4);
    expect(monthsBetween('2026-07-15', '2026-01-31')).toBe(-6);
    expect(monthsBetween('2026-07-15', '2026-08-14')).toBe(0); // a day short of a month
    expect(monthsBetween('2026-07-15', '2026-08-15')).toBe(1);
    expect(monthsBetween(null, '2026-08-15')).toBeNull();
  });
});

describe('purity', () => {
  it('mutates none of its inputs', () => {
    const items = JSON.parse(JSON.stringify(ITEMS));
    const shares = JSON.parse(JSON.stringify(SHARES));
    underwriteProperty({ property: PROPERTY, totals: TOTALS, expense: { ...EXPENSE }, items, shares, options: OPTIONS, year: Y, todayIso: TODAY });
    expect(items).toEqual(ITEMS);
    expect(shares).toEqual(SHARES);
  });
});

// ── The whole chain, against the demo mock ───────────────────────────────────
// Written relationally rather than against pinned figures, so it keeps holding as the
// calendar moves and as the seed evolves.
describe('buildLenderPackage against the demo data', () => {
  it('reads a corporation and reports a coherent package', async () => {
    const pkg = await buildLenderPackage({ corporationId: 'corp-1', year: currentYear() });

    expect(pkg.corporation.name).toBe('Acme Holdings');
    expect(pkg.properties.length).toBeGreaterThan(0);

    // The rent roll ties to the income line, and the income line to the NOI.
    const rolled = pkg.rentRoll.reduce((s, r) => s + r.rent, 0);
    expect(Math.abs(rolled - pkg.portfolio.inPlaceRent)).toBeLessThan(0.01);
    const egi = pkg.portfolio.inPlaceRent + pkg.portfolio.reimbursements + pkg.portfolio.otherIncome;
    expect(Math.abs(egi - pkg.portfolio.egi)).toBeLessThan(0.01);
    expect(Math.abs((pkg.portfolio.egi - pkg.portfolio.opex) - pkg.portfolio.noi)).toBeLessThan(0.01);

    // The underwritten NOI is HIGHER than the one the Financials page shows, because
    // that view never counts the reimbursement it subtracted.
    expect(pkg.portfolio.appNoi).not.toBeNull();
    expect(pkg.portfolio.noi).toBeGreaterThan(pkg.portfolio.appNoi);

    // City Dental's term ended in May 2026 — it is holding over, and that rent is
    // exposed today rather than at some future date.
    const dental = pkg.rentRoll.find((r) => r.tenant === 'City Dental');
    expect(dental.holdover).toBe(true);
    expect(dental.total).toBe(dental.rent + dental.reimbursement);
    expect(pkg.rollover.buckets[0].key).toBe('holdover');
    expect(pkg.atRisk.leases.map((r) => r.tenant)).toContain('City Dental');

    // Every bucket sums back to the rent roll it came from.
    const bucketed = pkg.rollover.buckets.reduce((s, b) => s + b.rent, 0);
    expect(Math.abs(bucketed + pkg.rollover.undated.reduce((s, r) => s + r.rent, 0) - rolled)).toBeLessThan(0.01);

    // And the coverage falls when the near-term rollover is taken out.
    const c = coverage({
      egi: pkg.portfolio.egi, opex: pkg.portfolio.opex, atRisk: pkg.atRisk.total,
      buildingSf: pkg.portfolio.buildingSf, debtService: 80000,
    });
    expect(c.now.dscr).toBeGreaterThan(c.down.dscr);
    expect(pkg.notIncluded.map((g) => g.key)).toContain('debt');
  }, 30000);
});
