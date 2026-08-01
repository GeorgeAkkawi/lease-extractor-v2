// Slice 5c — reading a closing statement without capitalizing the wrong half of it.
//
// The expensive failure here is not a misread field. It is summing "total settlement
// charges" into basis: that capitalizes an operating expense over 39 years, so the
// purchase year reads better than it was AND the basis stays overstated for as long as
// the building is owned. These tests pin the classification that prevents it.
import { describe, it, expect } from 'vitest';
import {
  COST_TREATMENTS, treatmentInfo, classifyCosts, proposedAssets, notCapitalized, readSummary,
} from '../closingStatement';
import { depreciationSchedule } from '../depreciation';

// A realistic ALTA statement: a price, five capitalizable charges, two that buy the LOAN
// rather than the building, and five that buy nothing at all.
const READ = {
  purchase_price: 1450000,
  closing_date: '2019-06-14',
  land_value: null,
  land_value_quote: null,
  costs: [
    { label: "Owner's title insurance premium", amount: 4350, treatment: 'acquisition' },
    { label: 'Settlement / closing fee', amount: 1200, treatment: 'acquisition' },
    { label: 'Recording fees — deed', amount: 186, treatment: 'acquisition' },
    { label: 'State transfer tax', amount: 2175, treatment: 'acquisition' },
    { label: 'ALTA survey', amount: 2800, treatment: 'acquisition' },
    { label: 'Loan origination fee (1.0%)', amount: 10150, treatment: 'loan' },
    { label: "Lender's title policy", amount: 1425, treatment: 'loan' },
    { label: 'County property taxes 01/01–06/14', amount: 8940, treatment: 'expense' },
    { label: 'Prepaid hazard insurance', amount: 6300, treatment: 'expense' },
    { label: 'Tenant security deposits transferred', amount: 21500, treatment: 'not_basis' },
    { label: 'Prorated June rent credited by seller', amount: 9416.67, treatment: 'not_basis' },
    { label: 'Lender escrow — initial funding', amount: 4550, treatment: 'not_basis' },
  ],
};

const ACQ = 4350 + 1200 + 186 + 2175 + 2800;       // 10,711
const LOAN = 10150 + 1425;                          // 11,575
const EXCLUDED = 8940 + 6300 + 21500 + 9416.67 + 4550; // 50,706.67

describe('what becomes basis, and what emphatically does not', () => {
  // ⚠ THE HEADLINE. The naive implementation sums every charge into the building's cost
  // and lands on $1,522,992.67. The correct answer is $50,706.67 lower, and the gap is
  // an entire year's prorated taxes, a year of prepaid insurance, the tenants' own
  // deposit money and the lender's escrow.
  it('never folds prorated taxes, deposits or escrow into the cost of the building', () => {
    const assets = proposedAssets(READ);
    const basis = assets.reduce((s, a) => s + a.cost, 0);

    expect(basis).toBe(1450000 + ACQ + LOAN);
    expect(basis).not.toBe(1450000 + ACQ + LOAN + EXCLUDED);
    expect(notCapitalized(READ).total).toBe(50706.67);
  });

  it('totals each destination in code — the model is never asked to add up', () => {
    const { groups } = classifyCosts(READ.costs);
    const total = (k) => groups.find((g) => g.key === k).total;
    expect(total('acquisition')).toBe(ACQ);
    expect(total('loan')).toBe(LOAN);
    expect(total('expense')).toBe(15240);
    expect(total('not_basis')).toBe(35466.67);
  });

  it('keeps the loan’s cost out of the building’s cost', () => {
    const assets = proposedAssets(READ);
    const building = assets.find((a) => a.kind === 'building');
    const loan = assets.find((a) => a.kind === 'loan_costs');
    // Points buy the loan. Folding them into the building would depreciate them over 39
    // years instead of the term of the debt.
    expect(building.cost).toBe(1450000);
    expect(loan.cost).toBe(LOAN);
  });

  it('creates no asset for a destination with nothing in it', () => {
    const noLoan = { ...READ, costs: READ.costs.filter((c) => c.treatment !== 'loan') };
    expect(proposedAssets(noLoan).some((a) => a.kind === 'loan_costs')).toBe(false);
  });

  // Same refusal assetKindInfo and dispositionInfo make: a treatment written by a later
  // round and read by an older cached bundle must not inherit another one's destination.
  // Unknown is never basis — guessing in that direction overstates what you own.
  it('refuses to capitalize a charge it could not classify', () => {
    const odd = { ...READ, costs: [{ label: 'Mystery fee', amount: 900, treatment: 'round_19_invention' }] };
    expect(treatmentInfo('round_19_invention').basis).toBeNull();
    expect(proposedAssets(odd).some((a) => a.kind === 'acquisition_costs')).toBe(false);
    expect(notCapitalized(odd).total).toBe(900);
  });
});

describe('the two things it refuses to invent', () => {
  // ⚠ THE LAND. It is an allocation DECISION, not a fact on the page, and a settlement
  // statement almost never states it. Round 9's whole refusal depends on this coming
  // back null rather than as a ratio.
  it('leaves the land unset when the document does not state it, and blocks rather than guessing', () => {
    const building = proposedAssets(READ).find((a) => a.kind === 'building');
    expect(building.land_cost).toBeNull();

    const sched = depreciationSchedule({ ...building, useful_life_years: 39 });
    expect(sched.blocked).toBe(true);
    expect(sched.reason).toMatch(/land value has not been set/);
  });

  it('uses a land value the document actually states', () => {
    const stated = { ...READ, land_value: 320000, land_value_quote: 'allocated to land: $320,000' };
    const building = proposedAssets(stated).find((a) => a.kind === 'building');
    expect(building.land_cost).toBe(320000);
    expect(depreciationSchedule({ ...building, useful_life_years: 39 }).blocked).toBe(false);
  });

  // null is not zero — a ground lease legitimately answers 0 and depreciates in full.
  it('keeps a stated zero as zero, not as unanswered', () => {
    const ground = { ...READ, land_value: 0 };
    expect(proposedAssets(ground).find((a) => a.kind === 'building').land_cost).toBe(0);
  });

  // ⚠ THE DATE. With no closing date there is nothing to place the building in service,
  // and an invented one is confidently wrong for thirty-nine years.
  it('refuses to invent a closing date, and says what is missing', () => {
    const undated = { ...READ, closing_date: null };
    const building = proposedAssets(undated).find((a) => a.kind === 'building');
    expect(building.placed_in_service).toBeNull();
    expect(building.blocked).toBe(true);
    expect(building.blockedReason).toMatch(/closing date/);
  });

  it('rejects a closing date that is not a real ISO date rather than passing it through', () => {
    expect(proposedAssets({ ...READ, closing_date: 'June 2019' })[0].placed_in_service).toBeNull();
  });

  // Points amortize over the TERM OF THE LOAN, which Amlak does not know until Slice 6.
  // Borrowing the building's 39 years would produce a confident schedule off a number
  // nobody chose — round 9 gave `loan_costs` no default life for exactly this moment.
  it('gives loan costs no life, and says why instead of borrowing one', () => {
    const loan = proposedAssets(READ).find((a) => a.kind === 'loan_costs');
    expect(loan.useful_life_years).toBeNull();
    expect(loan.blocked).toBe(true);
    expect(loan.blockedReason).toMatch(/term of your loan/);
    expect(depreciationSchedule(loan).blocked).toBe(true);
  });
});

describe('nothing is silently dropped', () => {
  it('accounts for every charge line — each is either an asset or explicitly excluded', () => {
    const s = readSummary(READ);
    expect(s.lineCount).toBe(12);
    expect(s.placed).toBe(12);
    expect(s.unreadable).toBe(0);
    expect(s.excludedCount).toBe(5);
    expect(s.assetCount).toBe(3);
  });

  it('counts a line with no readable amount rather than pretending it was zero', () => {
    const messy = { ...READ, costs: [...READ.costs, { label: 'Illegible', amount: null, treatment: 'acquisition' }] };
    const s = readSummary(messy);
    expect(s.unreadable).toBe(1);
    expect(s.placed).toBe(12);
    // …and it does not quietly reduce the basis to zero for that line either.
    expect(proposedAssets(messy).find((a) => a.kind === 'acquisition_costs').cost).toBe(ACQ);
  });

  it('names where each excluded group actually belongs', () => {
    const left = notCapitalized(READ);
    const expense = left.groups.find((g) => g.key === 'expense');
    const neither = left.groups.find((g) => g.key === 'not_basis');
    expect(expense.why).toMatch(/operating costs of the year/);
    expect(neither.why).toMatch(/without buying anything/);
    expect(left.lineCount).toBe(5);
  });

  it('handles a document that yielded nothing at all without throwing', () => {
    expect(proposedAssets({})).toEqual([]);
    expect(proposedAssets(null)).toEqual([]);
    expect(notCapitalized({}).total).toBe(0);
    expect(readSummary({}).lineCount).toBe(0);
  });

  it('is pure — reading twice does not change the read', () => {
    const snapshot = JSON.stringify(READ);
    proposedAssets(READ);
    notCapitalized(READ);
    readSummary(READ);
    expect(JSON.stringify(READ)).toBe(snapshot);
  });
});

describe('the registry stays coherent', () => {
  it('marks exactly the two destinations that become an asset', () => {
    expect(COST_TREATMENTS.filter((t) => t.basis).map((t) => t.key)).toEqual(['acquisition', 'loan']);
    expect(COST_TREATMENTS.map((t) => t.key)).toEqual(['acquisition', 'loan', 'expense', 'not_basis']);
  });
});
