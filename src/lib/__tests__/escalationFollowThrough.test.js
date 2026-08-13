// escalationFollowThrough: a rent step landed — did the money follow? (George,
// 2026-08-13: "how is the user supposed to know whether or not the tenant followed
// through on the escalation … recognize what the payment increase should have been on
// the base and see if the estimate cam and tax increased by that much".)
//
// Two things are pinned here and both are load-bearing:
//   • THE VERDICT is bill-vs-money-in over the SETTLED months since the step — the same
//     rule ledgerRowSummary.variance uses, so this line and the row's own `short $X` chip
//     can never disagree. A lump-covered month contributes nothing to either.
//   • THE DECOMPOSITION (base / CAM&tax / roof) always sums to billJump, because
//     componentizeSchedule enforces base + camTax + roof + adj === owed.
import { describe, it, expect } from 'vitest';
import { escalationFollowThrough, escalationStepMonths, allocatePayments, ledgerRowSummary } from '../ledger';

// Sam Nails' real 2026 shape: Jan–May base $4,106.08, Jun–Dec $4,160.20 (an applied
// 2026-06-01 step), combined CAM & tax $918/mo → the bill goes $5,024.08 → $5,078.20.
const PRE_BASE = 4106.08;
const POST_BASE = 4160.20;
const CAMTAX = 918;
const STEP_MONTH = 6;

// {schedule, comp} the way buildLeaseSchedule + componentizeSchedule produce them.
// `camTaxByMonth` lets a test move the ESTIMATE in the same month as the step, which is
// the case George's question is really about.
function build({ stepMonth = STEP_MONTH, pre = PRE_BASE, post = POST_BASE, camTax = CAMTAX, camTaxAfter = null, roof = 0 } = {}) {
  const schedule = {};
  const comp = {};
  for (let m = 1; m <= 12; m++) {
    const base = m < stepMonth ? pre : post;
    const ct = camTaxAfter != null && m >= stepMonth ? camTaxAfter : camTax;
    schedule[m] = { owed: round2(base + ct + roof), outsideTerm: false, abated: false };
    comp[m] = { base, camTax: ct, roof, adj: 0 };
  }
  return { schedule, comp };
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const owedArr = (schedule) => Array.from({ length: 12 }, (_, i) => schedule[i + 1].owed);

// One tagged payment per month, at `amountFor(m)`. Tagged = settled, which is the only
// kind of month the verdict counts.
function pay(months, amountFor) {
  return months.map((m) => ({ amount: amountFor(m), period_month: m, paid_date: `2026-${String(m).padStart(2, '0')}-05` }));
}

// Judge as though the whole year has come due.
const LATE = new Date(2027, 0, 15, 12);

function run({ payments, today = LATE, ...opts } = {}) {
  const { schedule, comp } = build(opts);
  const allocation = allocatePayments({ owedByMonth: schedule, payments });
  const steps = escalationStepMonths({ schedule, comp });
  const follow = escalationFollowThrough({ year: 2026, owedByMonth: schedule, allocation, steps, comp, today });
  return { schedule, comp, allocation, steps, follow: follow[0], all: follow };
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe('escalationFollowThrough — the verdict', () => {
  it('honored: every month settles at its own bill', () => {
    const { schedule } = build();
    const owed = owedArr(schedule);
    const { follow } = run({ payments: pay(ALL_MONTHS, (m) => owed[m - 1]) });
    expect(follow.verdict).toBe('honored');
    expect(follow.shortSince).toBe(0);
    expect(follow.settledSince).toBe(7); // Jun–Dec
  });

  it('pre_raise_rate: the cheque never moved — the gap IS the step', () => {
    const { follow } = run({ payments: pay(ALL_MONTHS, () => round2(PRE_BASE + CAMTAX)) });
    expect(follow.verdict).toBe('pre_raise_rate');
    expect(follow.month).toBe(6);
    expect(follow.billJump).toBe(54.12);
    expect(follow.shortPerMonth).toBe(54.12);
    expect(follow.shortSince).toBe(round2(54.12 * 7));
    // Nothing was short before the step, so the gap is not blamed on something older.
    expect(follow.shortBeforePerMonth).toBe(0);
  });

  it('partial: the cheque moved, but not by the whole increase', () => {
    const { follow } = run({
      payments: pay(ALL_MONTHS, (m) => (m < STEP_MONTH ? round2(PRE_BASE + CAMTAX) : round2(PRE_BASE + CAMTAX + 30))),
    });
    expect(follow.verdict).toBe('partial');
    expect(follow.shortPerMonth).toBe(24.12); // 54.12 − 30 picked up
  });

  it('older_gap: already short BEFORE the raise — never blamed on the step', () => {
    // $100/mo under all year, plus the ignored $54.12 step from June.
    const { follow } = run({
      payments: pay(ALL_MONTHS, () => round2(PRE_BASE + CAMTAX - 100)),
    });
    expect(follow.verdict).toBe('older_gap');
    expect(follow.shortPerMonth).toBe(154.12);
    expect(follow.shortBeforePerMonth).toBe(100);
  });

  it('over: paying above the new bill', () => {
    const { schedule } = build();
    const owed = owedArr(schedule);
    const { follow } = run({ payments: pay(ALL_MONTHS, (m) => round2(owed[m - 1] + 25)) });
    expect(follow.verdict).toBe('over');
  });

  it('pending: nothing settled at or after the step yet', () => {
    // Jan–May paid in full; June onward not yet due (judged from mid-June).
    const { schedule } = build();
    const owed = owedArr(schedule);
    const { follow } = run({
      payments: pay([1, 2, 3, 4, 5], (m) => owed[m - 1]),
      today: new Date(2026, 5, 15, 12),
    });
    expect(follow.verdict).toBe('pending');
    expect(follow.settledSince).toBe(0);
  });

  it('a month covered by an UNTAGGED lump counts for nothing — same rule as variance', () => {
    // One lump big enough to cover Jan–Dec at the pre-raise rate. It pools FIFO, so the
    // late months are part-covered — but nothing is TAGGED, so there is no variance to
    // read and the verdict must stay `pending` rather than invent a shortfall.
    const lump = [{ amount: round2((PRE_BASE + CAMTAX) * 12), period_month: null, paid_date: '2026-01-05' }];
    const { follow, allocation, schedule } = run({ payments: lump });
    expect(follow.verdict).toBe('pending');
    expect(follow.shortSince).toBe(0);
    // …and the row's own chip agrees: variance is settled-only too.
    const summary = ledgerRowSummary({ year: 2026, owedByMonth: schedule, allocation, today: LATE });
    expect(summary.variance).toBe(0);
  });
});

describe('escalationFollowThrough — what the bill went up by', () => {
  it('splits the jump into base + CAM&tax + roof, always summing to billJump', () => {
    // The step month ALSO carries a CAM & tax estimate change — George's actual question.
    const { follow } = run({
      camTaxAfter: CAMTAX + 120,
      payments: pay(ALL_MONTHS, () => round2(PRE_BASE + CAMTAX)),
    });
    expect(follow.stepMonthly).toBe(54.12);
    expect(follow.camTaxMonthly).toBe(120);
    expect(follow.roofMonthly).toBe(0);
    expect(round2(follow.stepMonthly + follow.camTaxMonthly + follow.roofMonthly)).toBe(follow.billJump);
    expect(follow.billJump).toBe(174.12);
    // The cheque didn't move at all, so it is short the WHOLE jump, not just the raise —
    // which is the distinction the decomposition exists to make readable.
    expect(follow.shortPerMonth).toBe(174.12);
    expect(follow.verdict).toBe('pre_raise_rate');
  });

  it('says nothing about components when comp is omitted (the alert path)', () => {
    const { schedule, comp } = build();
    const allocation = allocatePayments({ owedByMonth: schedule, payments: pay(ALL_MONTHS, () => round2(PRE_BASE + CAMTAX)) });
    const steps = escalationStepMonths({ schedule, comp });
    const [f] = escalationFollowThrough({ year: 2026, owedByMonth: schedule, allocation, steps, today: LATE });
    expect(f.stepMonthly).toBeNull();
    expect(f.camTaxMonthly).toBeNull();
    // The verdict and the jump still stand — they need arrays only.
    expect(f.billJump).toBe(54.12);
    expect(f.verdict).toBe('pre_raise_rate');
  });
});

describe('escalationFollowThrough — edges', () => {
  it('a flat (unstepped) lease returns nothing', () => {
    const { follow, all } = run({ pre: PRE_BASE, post: PRE_BASE, payments: [] });
    expect(all).toEqual([]);
    expect(follow).toBeUndefined();
  });

  it('returns one entry per step, in month order, when a lease steps twice', () => {
    // Mar → $4,200, Sep → $4,400; paid at the old rate all year.
    const schedule = {};
    const comp = {};
    for (let m = 1; m <= 12; m++) {
      const base = m < 3 ? 4000 : m < 9 ? 4200 : 4400;
      schedule[m] = { owed: base + CAMTAX, outsideTerm: false, abated: false };
      comp[m] = { base, camTax: CAMTAX, roof: 0, adj: 0 };
    }
    const allocation = allocatePayments({ owedByMonth: schedule, payments: pay(ALL_MONTHS, () => 4000 + CAMTAX) });
    const steps = escalationStepMonths({ schedule, comp });
    const follow = escalationFollowThrough({ year: 2026, owedByMonth: schedule, allocation, steps, comp, today: LATE });
    expect(follow.map((f) => f.month)).toEqual([3, 9]);
    expect(follow[0].billJump).toBe(200);
    expect(follow[1].billJump).toBe(200);
    // Neither entry claims "still at the pre-raise rate", and both are right not to.
    // Measured from March the tenant is short $280/mo — MORE than the $200 March step,
    // because a second raise landed in September, so it reads `partial`. Measured from
    // September the months before it were already short, so it reads `older_gap`. The
    // one verdict that would be a false accusation ("the gap IS this step") is exactly
    // the one neither produces — which is also the only verdict the dashboard raises.
    expect(follow[0].verdict).toBe('partial');
    expect(follow[0].shortPerMonth).toBe(280);
    expect(follow[1].verdict).toBe('older_gap');
    // Averaged across ALL eight settled months before September — Jan and Feb were fine,
    // Mar–Aug were $200 short: 1200 / 8 = 150. The figure answers "how short was this
    // tenant running before this step", which is what the sentence claims, not "how big
    // was the earlier step".
    expect(follow[1].shortBeforePerMonth).toBe(150);
  });

  it('no steps or no allocation → empty, never a throw', () => {
    expect(escalationFollowThrough()).toEqual([]);
    expect(escalationFollowThrough({ steps: [], allocation: {} })).toEqual([]);
    expect(escalationFollowThrough({ steps: [{ month: 6 }], allocation: null })).toEqual([]);
  });

  it('ignores months that have not come due yet', () => {
    // Judged from mid-August: only June and July can be counted, even though the
    // allocation has nothing on Aug–Dec.
    const { follow } = run({
      payments: pay([6, 7], () => round2(PRE_BASE + CAMTAX)),
      today: new Date(2026, 7, 15, 12),
    });
    expect(follow.settledSince).toBe(2);
    expect(follow.shortSince).toBe(round2(54.12 * 2));
    expect(follow.verdict).toBe('pre_raise_rate');
  });
});
