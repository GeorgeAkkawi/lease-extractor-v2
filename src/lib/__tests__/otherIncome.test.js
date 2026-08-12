// Slice 4c — money IN that isn't rent, and the security deposit.
//
// THE ONE THING EVERY TEST HERE GUARDS: a deposit that is not rent must never reach
// `payments`. Booked against a lease it credits that tenant's annual invoice, so
// allocatePayments reads the month over-paid and the Ledger's Collected column reports
// rent that never arrived — it CORRUPTS a figure the landlord trusts, where round 7's
// missing distribution merely omitted one.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  INCOME_CATEGORIES, incomeCategoryInfo, incomeCategoryLabel, isIncomeCategory,
  summarizeOtherIncome, incomeByLease,
} from '../otherIncome';
import { depositReconciliation, depositLinesFor, totalDepositsHeld } from '../deposits';
import { depositAmountFrom } from '../../../supabase/functions/_shared/rentSchedule.js';
import { looksLikeSecurityDeposit, matchStatement } from '../statementMatch';
import { dispositionForRow, isPlaced, lineCompleteness } from '../dispositions';
import {
  applyStatementImport, undoStatementImport, listOtherIncome, addOtherIncomeEntry,
  deleteOtherIncomeEntry, placeUnplacedLine, listUnplacedLines, listDepositLinesForLease,
  getLease, setLeaseSecurityDeposit, getMonthlyRent, getTenantShares, getExpenseRecord,
  listPayments, getYearInvoice,
} from '../api';
import { currentYear } from '../format';

const Y = currentYear();

describe('the income vocabulary', () => {
  it('names the kinds of income a building actually receives', () => {
    expect(INCOME_CATEGORIES.map((c) => c.key)).toEqual(['late_fee', 'parking', 'laundry', 'utility', 'insurance', 'other']);
    // ⚠ Every member is money the PROPERTY EARNED, and the Income-and-expenses workbook
    // prints the lot as revenue. Money the owner PUTS IN is deliberately absent — it
    // files as a `transfer`, which records no amount — because a contribution sitting in
    // this list would inflate revenue by exactly what the landlord funded himself.
    expect(INCOME_CATEGORIES.some((c) => /contribution|owner|capital/i.test(c.key))).toBe(false);
    expect(isIncomeCategory('late_fee')).toBe(true);
    expect(isIncomeCategory('rent')).toBe(false);
    // An unknown category falls back rather than throwing — a row written by a later
    // round must still render in an older bundle.
    expect(incomeCategoryInfo('spaceport').label).toBe('Other income');
    expect(incomeCategoryLabel('parking')).toBe('Parking');
  });

  it('groups by category, biggest first, from absolute amounts', () => {
    const s = summarizeOtherIncome([
      { category: 'late_fee', amount: 250 },
      { category: 'parking', amount: 1800 },
      { category: 'late_fee', amount: 75 },
      // A sign slip must not cancel a real receipt — that would under-report in the
      // direction that hides money.
      { category: 'utility', amount: -640 },
      { category: 'spaceport', amount: 10 },   // unknown → folded into Other
    ]);
    expect(s.total).toBe(2775);
    expect(s.groups.map((g) => [g.key, g.total])).toEqual([
      ['parking', 1800], ['utility', 640], ['late_fee', 325], ['other', 10],
    ]);
  });

  it('attributes income to the tenant who paid it, without billing anything', () => {
    const by = incomeByLease([
      { lease_id: 'a', amount: 250 }, { lease_id: 'a', amount: 75 }, { lease_id: null, amount: 900 },
    ]);
    expect(by).toEqual([{ lease_id: 'a', total: 325, count: 2 }]);
  });
});

describe('the deposit stated in the lease', () => {
  it('reads a dollar figure, and multiplies a months-of-rent figure in CODE', () => {
    expect(depositAmountFrom([{ amount: 5000, basis: 'dollars', quote: 'the sum of $5,000' }], 4000))
      .toEqual({ amount: 5000, quote: 'the sum of $5,000' });
    // "two months' Base Rent" at $4,000/mo — the model returns 2, we do the arithmetic.
    expect(depositAmountFrom([{ amount: 2, basis: 'months_rent', quote: 'two (2) months' }], 4000).amount).toBe(8000);
  });

  it('returns nothing rather than a guess when it cannot resolve one', () => {
    // A months-of-rent deposit with no rent to multiply is unresolvable. This figure is
    // what a bank line reconciles against, so a wrong one is worse than none.
    expect(depositAmountFrom([{ amount: 2, basis: 'months_rent', quote: '' }], 0)).toBeNull();
    expect(depositAmountFrom([], 4000)).toBeNull();
    expect(depositAmountFrom([{ amount: 0, basis: 'dollars', quote: '' }], 4000)).toBeNull();
    expect(depositAmountFrom(null, 4000)).toBeNull();
  });
});

describe('the cross-check nobody else can run', () => {
  const line = (amount, leaseId = 'L1') => ({ disposition: 'deposit_held', ref_id: leaseId, amount });

  it('picks out only this lease’s deposit lines', () => {
    const lines = [line(5000, 'L1'), line(1000, 'L2'), { disposition: 'rent', ref_id: 'L1', amount: 7000 }];
    expect(depositLinesFor(lines, 'L1')).toHaveLength(1);
    expect(depositLinesFor(lines, null)).toHaveLength(0);
  });

  it('says nothing when there is nothing to say, and matches when they agree', () => {
    expect(depositReconciliation({ stated: null, lines: [] }).state).toBe('none');
    const ok = depositReconciliation({ stated: 5000, lines: [line(5000)] });
    expect(ok.state).toBe('matched');
    expect(ok.tone).toBe('good');
  });

  // ⚠ The judgement that keeps this from becoming noise. A deposit taken in 2019 has no
  // bank line in Amlak and never will — that is the OVERWHELMINGLY common case, so it
  // is stated as a fact and NOT flagged. Flagging it would teach George to ignore the
  // one case that matters.
  it('does not flag the normal case: the lease states one and no bank line records it', () => {
    const r = depositReconciliation({ stated: 5000, lines: [] });
    expect(r.state).toBe('stated_only');
    expect(r.tone).toBeNull();
    expect(r.sentence).toMatch(/before you started importing/);
  });

  it('DOES flag the reverse — money arrived and the lease records no deposit', () => {
    const r = depositReconciliation({ stated: null, lines: [line(5000)] });
    expect(r.state).toBe('received_only');
    expect(r.tone).toBe('warn');
  });

  it('reports short and over, and treats a few cents as rounding', () => {
    expect(depositReconciliation({ stated: 5000, lines: [line(4000)] })).toMatchObject({ state: 'short', difference: -1000, tone: 'warn' });
    expect(depositReconciliation({ stated: 5000, lines: [line(4000), line(2000)] })).toMatchObject({ state: 'over', difference: 1000 });
    expect(depositReconciliation({ stated: 5000, lines: [line(5000.03)] }).state).toBe('matched');
  });

  it('totals what you are holding across leases, ignoring the ones holding nothing', () => {
    expect(totalDepositsHeld([{ security_deposit: 5000 }, { security_deposit: null }, { security_deposit: 0 }, { security_deposit: 2500 }]))
      .toEqual({ total: 7500, count: 2 });
  });
});

describe('recognizing a deposit before it books as rent', () => {
  const txn = (description, amount) => ({ description, amount, direction: 'in', date: `${Y}-03-05` });
  const cand = (over = {}) => ({ lease_id: 'L1', corroborated: false, toRecon: false, ...over });
  const tenant = (over = {}) => ({ lease_id: 'L1', securityDeposit: 5000, ...over });

  it('believes the line when it says so in words', () => {
    expect(looksLikeSecurityDeposit(txn('ACH SECURITY DEPOSIT CITY DENTAL', 5000), cand(), tenant())).toBeTruthy();
    expect(looksLikeSecurityDeposit(txn('SEC DEP RECEIVED', 5000), cand(), tenant())).toBeTruthy();
  });

  // ⚠ THE REGRESSION THAT MATTERS. Every bank in America prints "DEPOSIT" on ordinary
  // rent lines, so matching the bare word would reclassify a property's whole rent roll
  // — the same word-boundary failure round 7 found when "WITHDRAWAL" matched "DRAW".
  it('never treats the bare word "deposit" as a signal', () => {
    expect(looksLikeSecurityDeposit(txn('MOBILE DEPOSIT 4471', 7000), cand(), tenant())).toBeNull();
    expect(looksLikeSecurityDeposit(txn('REMOTE DEPOSIT CITY DENTAL', 7000), cand(), tenant())).toBeNull();
  });

  it('recognizes an amount that equals the stated deposit and settles no month', () => {
    expect(looksLikeSecurityDeposit(txn('CITY DENTAL ACH', 5000), cand(), tenant()).reason).toMatch(/\$5,000\.00/);
  });

  // Both halves are required. A deposit often equals one month's rent, so an amount
  // that CORROBORATES a billed month is rent that happens to resemble the deposit.
  it('leaves it as rent when the amount settles a month the tenant owes', () => {
    expect(looksLikeSecurityDeposit(txn('CITY DENTAL ACH', 5000), cand({ corroborated: true }), tenant())).toBeNull();
  });

  it('says nothing when the lease states no deposit', () => {
    expect(looksLikeSecurityDeposit(txn('CITY DENTAL ACH', 5000), cand(), tenant({ securityDeposit: null }))).toBeNull();
  });

  it('suggests it through the matcher, and never auto-ticks it', () => {
    const tenants = [{
      lease_id: 'L1', property_id: 'P1', property_name: 'Maple', tenant_name: 'City Dental',
      securityDeposit: 5000, monthly: 7000,
      owed: Array(12).fill(7000), coverage: Array(12).fill(0), reconBalance: 0,
    }];
    const { rows } = matchStatement({
      transactions: [{ description: 'ACH SECURITY DEPOSIT CITY DENTAL', amount: 5000, direction: 'in', date: `${Y}-03-05` }],
      propertyId: 'P1', tenants,
    });
    expect(rows[0].kind).toBe('deposit_held');
    // Money that is not rent is confirmed by a human even when the line says so in
    // words — the cost of being wrong is a corrupted Ledger.
    expect(rows[0].checked).toBe(false);
    expect(rows[0].month).toBeNull();
  });
});

describe('the disposition vocabulary', () => {
  it('counts both new members as placed, and still leaves only unclassified unplaced', () => {
    expect(isPlaced('other_income')).toBe(true);
    expect(isPlaced('deposit_held')).toBe(true);
    expect(isPlaced('unclassified')).toBe(false);
    // Slice 5/6 kinds are genuinely unbuilt, so they must still read as unplaced.
    expect(isPlaced('debt')).toBe(false);
    expect(lineCompleteness([
      { disposition: 'other_income', amount: 250, direction: 'in' },
      { disposition: 'deposit_held', amount: 5000, direction: 'in' },
      { disposition: 'unclassified', amount: 900, direction: 'in' },
    ])).toMatchObject({ placed: 2, unplaced: 1, unplacedIn: 900 });
  });

  it('needs the tick for both, because both record something', () => {
    expect(dispositionForRow({ checked: true, kind: 'other_income', picked: true })).toBe('other_income');
    expect(dispositionForRow({ checked: false, kind: 'other_income', picked: true })).toBe('unclassified');
    expect(dispositionForRow({ checked: true, kind: 'deposit_held', picked: true })).toBe('deposit_held');
    expect(dispositionForRow({ checked: false, kind: 'deposit_held', picked: true })).toBe('unclassified');
  });
});

// ---- against the demo mock: the real write path ------------------------------
describe('a late fee imported from a statement', () => {
  let before;
  beforeEach(async () => {
    before = {
      invoice: await getYearInvoice('lease-2', Y),
      months: await getMonthlyRent('lease-2', Y),
      payments: await listPayments((await getYearInvoice('lease-2', Y))?.id),
      shares: await getTenantShares('prop-1', Y),
      cam: await getExpenseRecord('prop-1', Y),
    };
  });

  // ⚠ THE TEST THIS WHOLE ROUND EXISTS FOR. A $250 late fee from City Dental is real
  // income AND genuinely from that tenant — but if it reaches `payments` it settles
  // rent that was never paid.
  it('is recorded against the tenant WITHOUT touching a single rent figure', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'fee.csv',
      entries: [{
        type: 'income', property_id: 'prop-1', lease_id: 'lease-2', year: Y,
        amount: 250, date: `${Y}-03-12`, category: 'late_fee', label: 'Late fee', hash: 'h-fee',
      }],
      lines: [{ hash: 'h-fee', year: Y, date: `${Y}-03-12`, description: 'ACH LATE FEE CITY DENTAL', amount: 250, direction: 'in', disposition: 'other_income' }],
    });

    // It is recorded, and it names who it came from…
    const inc = await listOtherIncome('prop-1', Y);
    expect(inc.find((r) => r.line_hash === 'h-fee')).toMatchObject({ category: 'late_fee', amount: 250, lease_id: 'lease-2' });

    // …and NOT ONE rent figure moved.
    const inv = await getYearInvoice('lease-2', Y);
    expect(inv.total_amount).toBe(before.invoice.total_amount);
    expect(inv.amount_paid).toBe(before.invoice.amount_paid);
    expect((await listPayments(inv.id)).length).toBe(before.payments.length);
    // The per-month picture the Ledger boxes paint: not one month moved, and the
    // year's owed schedule is byte-identical.
    const after = await getMonthlyRent('lease-2', Y);
    expect(after.byMonth).toEqual(before.months.byMonth);
    expect(after.schedule).toEqual(before.months.schedule);
    expect(after.annual).toBe(before.months.annual);
    expect((await getTenantShares('prop-1', Y)).map((s) => s.total_due))
      .toEqual(before.shares.map((s) => s.total_due));
    // Nor is it an expense, in either direction.
    expect((await getExpenseRecord('prop-1', Y)).cam_total).toBe(before.cam.cam_total);

    // Counted APART from payments — folding it in would report rent collection that
    // never happened, one screen earlier.
    expect(res.summary.paymentsCount).toBe(0);
    expect(res.summary.incomeCount).toBe(1);
    expect(res.summary.incomeTotal).toBe(250);

    await undoStatementImport(res.import);
    expect((await listOtherIncome('prop-1', Y)).some((r) => r.line_hash === 'h-fee')).toBe(false);
  });
});

describe('a security deposit imported from a statement', () => {
  it('records that it arrived, and NEVER overwrites what the lease says is held', async () => {
    const stated = (await getLease('lease-1')).security_deposit;
    expect(stated).toBe(10000);

    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'dep.csv',
      entries: [{ type: 'deposit', property_id: 'prop-1', lease_id: 'lease-1', year: Y, amount: 10000, hash: 'h-dep' }],
      lines: [{ hash: 'h-dep', year: Y, date: `${Y}-01-04`, description: 'ACH SECURITY DEPOSIT BRIGHT COFFEE', amount: 10000, direction: 'in', disposition: 'deposit_held' }],
    });

    // The lease term is untouched — the bank figure never writes over the document.
    expect((await getLease('lease-1')).security_deposit).toBe(10000);
    // …and the line points back at the lease, which IS the whole record.
    const lines = await listDepositLinesForLease('lease-1');
    expect(lines).toHaveLength(1);
    expect(depositReconciliation({ stated, lines }).state).toBe('matched');
    // It is not a payment and not income.
    expect(res.summary.paymentsCount).toBe(0);
    expect(res.summary.incomeCount).toBe(0);
    expect(res.summary.depositCount).toBe(1);
    expect((await listOtherIncome('prop-1', Y)).some((r) => r.line_hash === 'h-dep')).toBe(false);

    await undoStatementImport(res.import);
    // Undo takes the evidence away and leaves the lease term alone — the import never
    // wrote it, so there is nothing to restore.
    expect(await listDepositLinesForLease('lease-1')).toHaveLength(0);
    expect((await getLease('lease-1')).security_deposit).toBe(10000);
  });

  it('a deposit against a lease that states none is reported, not absorbed', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'dep2.csv',
      entries: [{ type: 'deposit', property_id: 'prop-1', lease_id: 'lease-2', year: Y, amount: 7000, hash: 'h-dep2' }],
      lines: [{ hash: 'h-dep2', year: Y, date: `${Y}-01-06`, description: 'SECURITY DEPOSIT CITY DENTAL', amount: 7000, direction: 'in', disposition: 'deposit_held' }],
    });
    const lease = await getLease('lease-2');
    expect(lease.security_deposit).toBeFalsy();
    const r = depositReconciliation({ stated: lease.security_deposit, lines: await listDepositLinesForLease('lease-2') });
    expect(r.state).toBe('received_only');
    expect(r.tone).toBe('warn');
    await undoStatementImport(res.import);
  });
});

describe('placing a line from the Ledger panel', () => {
  it('records income without re-importing, and links what it produced', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'unplaced-in.csv', entries: [],
      lines: [{ hash: 'h-p1', year: Y, date: `${Y}-04-02`, description: 'PARKING LOT PERMITS', amount: 1800, direction: 'in', disposition: 'unclassified' }],
    });
    const [line] = await listUnplacedLines('prop-1', Y);
    const { entry } = await placeUnplacedLine(line, { kind: 'income', category: 'parking' });
    expect(entry).toMatchObject({ category: 'parking', amount: 1800 });
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(0);
    await deleteOtherIncomeEntry(entry.id);
    await undoStatementImport(res.import);
  });

  it('records a deposit with NO row at all — the line pointing at its lease is the record', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'unplaced-dep.csv', entries: [],
      lines: [{ hash: 'h-p2', year: Y, date: `${Y}-04-03`, description: 'DEPOSIT FROM NEW TENANT', amount: 3000, direction: 'in', disposition: 'unclassified' }],
    });
    const [line] = await listUnplacedLines('prop-1', Y);
    const beforeIncome = (await listOtherIncome('prop-1', Y)).length;
    const out = await placeUnplacedLine(line, { kind: 'deposit', leaseId: 'lease-2' });
    expect(out.entry).toBeNull();
    expect((await listOtherIncome('prop-1', Y)).length).toBe(beforeIncome);
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(0);
    expect(await listDepositLinesForLease('lease-2')).toHaveLength(1);
    await undoStatementImport(res.import);
  });
});

describe('the deposit as a lease term', () => {
  it('saves by hand and clears back to null, moving no billed figure', async () => {
    const before = await getYearInvoice('lease-2', Y);
    await setLeaseSecurityDeposit('lease-2', 6000);
    expect((await getLease('lease-2')).security_deposit).toBe(6000);
    // "No deposit" and "a deposit of zero" are the same fact.
    await setLeaseSecurityDeposit('lease-2', '');
    expect((await getLease('lease-2')).security_deposit).toBeNull();
    expect((await getYearInvoice('lease-2', Y)).total_amount).toBe(before.total_amount);
  });
});
