// Statement matching — rule precedence, tenant fuzzy + amount corroboration,
// month suggestion vs the FIFO pool, the duplicate guard, the hand-entry
// collision flag, the withdrawal keyword table, and the majority-vote property
// detector. All pure, suggest-only.
import { describe, it, expect } from 'vitest';
import {
  normalizeDesc, lineHash, tenantNameScore, amountMatches, suggestRulePattern,
  classifyWithdrawal, corroborateAmount, rankDepositCandidates, matchStatement,
  findMatchingRule, depositProjectionDelta, stepAtOrBefore, screenRulePatterns,
} from '../statementMatch';

const flat = (n) => Array(12).fill(n);
// A stepped tenant: Jan–May $4,106.08, Jun–Dec $4,160.20 (a June base step of $54.12) —
// Sam Nails' real shape. `steps` is escalationStepMonths' output (base delta = 54.12).
const stepped = (over = {}) => ({
  lease_id: 'lease-8', property_id: 'prop-3', property_name: 'GENA',
  tenant_name: 'Sam Nails', monthly: 4137.65,
  owed: [4106.08, 4106.08, 4106.08, 4106.08, 4106.08, 4160.20, 4160.20, 4160.20, 4160.20, 4160.20, 4160.20, 4160.20],
  coverage: flat(0),
  steps: [{ month: 6, owed: 4160.20, base: 2160.20, prevBase: 2106.08 }],
  invoiceTotal: 49475.80, invoiceBalance: 49475.80, reconInvoiceId: null, reconBalance: 0,
  ...over,
});
const txn = (over = {}) => ({ date: '2026-05-02', description: 'CHECK 1044 CITY DENTAL PC', amount: 8208.33, direction: 'in', balance: null, line: 2, ...over });

// A tenant context row the api layer will assemble from the ledger roll.
const cityDental = (over = {}) => ({
  lease_id: 'lease-2', property_id: 'prop-1', property_name: 'Maple Plaza',
  tenant_name: 'City Dental', monthly: 8208.33,
  owed: flat(8208.33), coverage: [8208.33, 8208.33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  invoiceTotal: 98500, invoiceBalance: 82083.34, reconInvoiceId: null, reconBalance: 0,
  ...over,
});

describe('name matching', () => {
  it('drops corporate noise (LLC/INC/&/THE) before scoring', () => {
    expect(tenantNameScore('ACH HEGAZY D D DENTAL PAYMENT', 'D & D Dental, LLC')).toBe(1);
    expect(tenantNameScore('CHECK 1044 CITY DENTAL PC', 'City Dental')).toBe(1);
    expect(tenantNameScore('COUNTY TREASURER', 'City Dental')).toBe(0);
  });
  it('lineHash is stable and normalization-insensitive', () => {
    const a = lineHash(txn({ description: 'Check  1044,  CITY dental pc.' }));
    const b = lineHash(txn({ description: 'CHECK 1044 CITY DENTAL PC' }));
    expect(a).toBe(b);
    expect(normalizeDesc('  Check #1044 — City Dental. ')).toBe('CHECK 1044 CITY DENTAL');
  });
  it('suggestRulePattern picks the longest run that is neither digits nor rail wording', () => {
    expect(suggestRulePattern('CHECK 1044 CITY DENTAL PC')).toBe('CITY DENTAL PC');
    // "ACH" names the payment rail, not the payee — every ACH tenant would match it.
    expect(suggestRulePattern('ACH A HEGAZY 2211')).toBe('A HEGAZY');
    expect(suggestRulePattern('12 34 56')).toBe(null); // nothing rule-worthy
  });

  // George's real Chase statement taught ONE rule ("ONLINE ACH DEBIT") that swallowed
  // six different tenants, and a second of pure boilerplate that matched nearly every
  // line — because the longest digit-free run on a bank line is the rail's own wording.
  // Each of these must now yield ITS OWN payee, and none may yield the rail.
  describe('a bank line is learned by its payee, never by the rail', () => {
    const CHASE = [
      ['Online ACH Debit 9031521835 From Gustavo', 'GUSTAVO'],
      ['Online ACH Debit 9031473238 From Samsnails', 'SAMSNAILS'],
      ['Online ACH Debit 9031500012 From Lyonsvapez', 'LYONSVAPEZ'],
      ['Online ACH Debit 9031500013 From Chinese', 'CHINESE'],
      ['Online ACH Debit 9031500014 From Boost', 'BOOST'],
      ['Online ACH Debit 9031500015 From Hiarcut', 'HIARCUT'],
      ['Orig CO Name:Five Points Wing Orig ID:9200502235 Desc Date:060126 CO Entry Descr:ACH PAYMENSEC:CCD', 'FIVE POINTS WING'],
      ['Orig CO Name:Laredo Hospitali Orig ID:9200502235 Desc Date:060126 CO Entry Descr:ACH PAYMENSEC:CCD Trace#:021000029', 'LAREDO HOSPITALI'],
      ['Orig CO Name:Dentaloffice Orig ID:9200502235 Desc Date:060126', 'DENTALOFFICE'],
    ];
    it('each of the nine gets its own payee — and none gets the rail wording', () => {
      const learned = CHASE.map(([desc]) => suggestRulePattern(desc));
      CHASE.forEach(([, want], i) => expect(learned[i]).toBe(want));
      expect(learned).not.toContain('ONLINE ACH DEBIT');
      expect(new Set(learned).size).toBe(CHASE.length); // nine payees, nine patterns
    });
    it('a line with nothing but rail wording and numbers is not learned at all', () => {
      expect(suggestRulePattern('ONLINE ACH DEBIT 9031521835')).toBe(null);
      expect(suggestRulePattern('Desc Date:060126 CO Entry Descr:ACH SEC:CCD Trace#:021000029')).toBe(null);
    });
  });

  // The guarantee that needs no word list: a pattern that can't tell two of your own
  // payees apart is not a payee, whatever the bank calls it.
  describe('screenRulePatterns — specificity within the same statement', () => {
    const lines = [
      { description: 'ONLINE ACH DEBIT 111 FROM GUSTAVO', targetKey: 'lease:a' },
      { description: 'ONLINE ACH DEBIT 222 FROM SAMSNAILS', targetKey: 'lease:b' },
      { description: 'CHECK 1044 CITY DENTAL PC', targetKey: 'lease:c' },
    ];
    it('rejects a pattern that also matches a line belonging to someone else', () => {
      const { keep, rejected } = screenRulePatterns(
        [{ pattern: 'ONLINE ACH DEBIT', targetKey: 'lease:a' }, { pattern: 'CITY DENTAL PC', targetKey: 'lease:c' }],
        lines
      );
      expect(keep.map((k) => k.pattern)).toEqual(['CITY DENTAL PC']);
      expect(rejected).toEqual([{ pattern: 'ONLINE ACH DEBIT', count: 2 }]);
    });
    it('two lines that are the SAME payee are not a conflict', () => {
      const same = [
        { description: 'CHECK 1044 CITY DENTAL PC', targetKey: 'lease:c' },
        { description: 'CHECK 1051 CITY DENTAL PC', targetKey: 'lease:c' },
      ];
      const { keep, rejected } = screenRulePatterns([{ pattern: 'CITY DENTAL PC', targetKey: 'lease:c' }], same);
      expect(keep).toHaveLength(1);
      expect(rejected).toHaveLength(0);
    });
    it('an unresolved line never contradicts anyone', () => {
      const { keep } = screenRulePatterns(
        [{ pattern: 'CITY DENTAL PC', targetKey: 'lease:c' }],
        [{ description: 'CHECK 1044 CITY DENTAL PC', targetKey: null }, ...lines]
      );
      expect(keep).toHaveLength(1);
    });
  });
  it('amountMatches allows ±$1 or ±1%', () => {
    expect(amountMatches(8208, 8208.33)).toBe(true);
    expect(amountMatches(8300, 8208.33)).toBe(false);
    expect(amountMatches(98000, 98500)).toBe(true); // 1% of 98,500 = 985
  });
});

describe('deposit corroboration', () => {
  it('one month\'s billed charge → the earliest uncovered owed month', () => {
    const c = corroborateAmount(8208.33, cityDental());
    expect(c).toMatchObject({ corroborated: true, month: 3 });
  });
  it('a mid-year tenant\'s first owed month is respected (pre-start months owe $0)', () => {
    const t = cityDental({ owed: [0, 0, 0, 0, 0, 0, 3000, 3000, 3000, 3000, 3000, 3000], coverage: flat(0), monthly: 3000, invoiceTotal: 18000, invoiceBalance: 18000 });
    const c = corroborateAmount(3000, t);
    expect(c.month).toBe(7); // July, not January
  });
  it('k consecutive months\' sum → untagged (the FIFO pool spreads it)', () => {
    const c = corroborateAmount(round(8208.33 * 3), cityDental());
    expect(c.corroborated).toBe(true);
    expect(c.month).toBe(null);
  });
  it('the invoice total / balance in one check → untagged', () => {
    expect(corroborateAmount(98500, cityDental()).month).toBe(null);
    expect(corroborateAmount(82083.34, cityDental()).corroborated).toBe(true);
  });
  it('an open reconciliation balance matches its true-up and carries NO month', () => {
    const t = cityDental({ reconInvoiceId: 'inv-recon', reconBalance: 985.04 });
    const c = corroborateAmount(985.04, t);
    expect(c).toMatchObject({ corroborated: true, toRecon: true, month: null });
  });
  function round(n) { return Math.round(n * 100) / 100; }
});

// George back-filled an old May statement onto a ledger whose open months started in
// July: every line was tagged to a month that hadn't happened when the money arrived,
// or to no month at all — and an untagged deposit pools forward, so May's rent settled
// July's box. The line's own month is the third input that fixes both.
describe('deposit corroboration — the month the money actually landed', () => {
  const openFromJuly = cityDental({ coverage: [8208.33, 8208.33, 8208.33, 8208.33, 8208.33, 8208.33, 0, 0, 0, 0, 0, 0] });

  it('with no third argument, behaviour is byte-identical to before', () => {
    expect(corroborateAmount(8208.33, openFromJuly)).toEqual({ corroborated: true, month: 7, toRecon: false });
  });
  it('a May deposit is never tagged to July — it falls back to its own month', () => {
    const c = corroborateAmount(8208.33, openFromJuly, 5);
    expect(c.month).toBe(5);
    expect(c.corroborated).toBe(false); // uncorroborated, so nothing newly auto-ticks
  });
  it('one month ahead is still allowed — rent is due on the 1st, so paying early is normal', () => {
    expect(corroborateAmount(8208.33, openFromJuly, 6)).toMatchObject({ corroborated: true, month: 7 });
  });
  it('a LATE payment still settles the month it owes (the earliest-owed rule stands)', () => {
    // August deposit, June still owed → June, exactly as before.
    expect(corroborateAmount(8208.33, openFromJuly, 8)).toMatchObject({ corroborated: true, month: 7 });
    expect(corroborateAmount(8208.33, cityDental(), 8)).toMatchObject({ corroborated: true, month: 3 });
  });
  it('nothing matches a billed figure → the line is dated from itself, not left to the pool', () => {
    const c = corroborateAmount(1234.56, cityDental(), 5);
    expect(c).toEqual({ corroborated: false, month: 5, toRecon: false });
  });
  it('a lease that bills nothing that month still keeps the date (the ledger says so out loud)', () => {
    const midYear = cityDental({ owed: [0, 0, 0, 0, 0, 0, 2716, 2716, 2716, 2716, 2716, 2716], coverage: Array(12).fill(0), invoiceTotal: 16296, invoiceBalance: 16296 });
    expect(corroborateAmount(2716, midYear, 5).month).toBe(5);
  });
  it('a true-up / k-month / whole-invoice match is still untagged', () => {
    const recon = cityDental({ reconInvoiceId: 'inv-recon', reconBalance: 985.04 });
    expect(corroborateAmount(985.04, recon, 5)).toMatchObject({ toRecon: true, month: null });
    expect(corroborateAmount(Math.round(8208.33 * 3 * 100) / 100, cityDental(), 5).month).toBe(null);
    expect(corroborateAmount(98500, cityDental(), 5).month).toBe(null);
  });
  it('matchStatement dates a line from the statement even when the amount matches nothing', () => {
    const { rows } = matchStatement({
      transactions: [txn({ date: '2026-05-02', description: 'CHECK 1044 CITY DENTAL PC', amount: 8500 })],
      propertyId: 'prop-1', tenants: [openFromJuly],
    });
    expect(rows[0].month).toBe(5);
    expect(rows[0].checked).toBe(false); // dated, but still the landlord's call
  });
});

describe('hand-entry collision', () => {
  it('a monthly-sized check against a FULLY covered year flags as possibly recorded by hand', () => {
    const t = cityDental({ coverage: flat(8208.33) });
    const [cand] = rankDepositCandidates(txn(), [t]);
    expect(cand.collision).toBe(true);
  });
  it('no collision when the months are genuinely open', () => {
    const [cand] = rankDepositCandidates(txn(), [cityDental()]);
    expect(cand.collision).toBe(false);
  });
});

describe('withdrawal keyword table', () => {
  it('tax / roof / CAM keywords classify with labels; mortgage & transfer suggest ignore with a reason', () => {
    expect(classifyWithdrawal('COOK COUNTY TREASURER PROP TAX')).toMatchObject({ kind: 'expense_tax' });
    expect(classifyWithdrawal('ABC ROOFING CO ROOF REPAIR')).toMatchObject({ kind: 'expense_roof' });
    expect(classifyWithdrawal('GREENLEAF LANDSCAPING INV 88')).toMatchObject({ kind: 'expense_cam', label: 'Landscaping' });
    expect(classifyWithdrawal('SNOW PLOW SERVICES')).toMatchObject({ kind: 'expense_cam', label: 'Snow removal' });
    const mort = classifyWithdrawal('CHASE MORTGAGE PMT');
    expect(mort.kind).toBe('ignore');
    expect(mort.reason).toContain('mortgage');
    expect(classifyWithdrawal('TRANSFER TO SAVINGS').kind).toBe('ignore');
  });
  it('unknown money-out is NEVER auto-booked', () => {
    const c = classifyWithdrawal('MISC PURCHASE 8812');
    expect(c.kind).toBe('ignore');
    expect(c.confidence).toBe('none');
  });
  it('money-out matching a tenant name points at the refund flow', () => {
    const c = classifyWithdrawal('CHECK TO CITY DENTAL', [cityDental()]);
    expect(c.kind).toBe('ignore');
    expect(c.reason).toContain('Mark refunded');
  });
});

describe('matchStatement — the driver', () => {
  it('a clean tenant deposit is high-confidence and pre-checked with its month', () => {
    const { rows } = matchStatement({ transactions: [txn()], propertyId: 'prop-1', tenants: [cityDental()] });
    expect(rows[0]).toMatchObject({ kind: 'tenant', confidence: 'high', checked: true, month: 3 });
  });

  it('rules win over fuzzy — the garbled-payee one-time fix', () => {
    const t = cityDental({ lease_id: 'lease-9', tenant_name: 'D & D Dental, LLC' });
    const rule = { pattern: 'HEGAZY', target_kind: 'tenant', lease_id: 'lease-9', property_id: 'prop-1', cam_label: null };
    const { rows } = matchStatement({
      transactions: [txn({ description: 'ACH A HEGAZY 2211' })],
      propertyId: 'prop-1', tenants: [t], rules: [rule],
    });
    expect(rows[0].confidence).toBe('rule');
    expect(rows[0].candidate.lease_id).toBe('lease-9');
    expect(rows[0].checked).toBe(true);
  });

  it('rules are direction-gated — a tenant rule never fires on money OUT', () => {
    const rule = { pattern: 'DENTAL', target_kind: 'tenant', lease_id: 'lease-2', property_id: 'prop-1' };
    const { rows } = matchStatement({
      transactions: [txn({ description: 'REFUND TO SOME DENTAL THING', direction: 'out' })],
      propertyId: 'prop-1', tenants: [], rules: [rule],
    });
    expect(rows[0].confidence).not.toBe('rule');
    expect(rows[0].kind).toBe('ignore');
  });

  it("each line's year comes from ITS OWN date", () => {
    const { rows } = matchStatement({
      transactions: [txn({ date: '2025-12-30' }), txn({ date: '2026-01-02' })],
      propertyId: 'prop-1', tenants: [cityDental()],
    });
    expect(rows[0].year).toBe(2025);
    expect(rows[1].year).toBe(2026);
  });

  it('the duplicate guard greys a known hash but stays overridable (checked=false, duplicate=true)', () => {
    const t = txn();
    const { rows } = matchStatement({
      transactions: [t], propertyId: 'prop-1', tenants: [cityDental()],
      existingHashes: new Set([lineHash(t)]),
    });
    expect(rows[0].duplicate).toBe(true);
    expect(rows[0].checked).toBe(false); // skipped by default, importable via override
    expect(rows[0].kind).toBe('tenant'); // the match itself still computed
  });

  it('a cross-property deposit matches the OTHER property\'s tenant', () => {
    const pershing = cityDental({ lease_id: 'lease-77', property_id: 'prop-9', property_name: 'Pershing Plaza', tenant_name: 'Wingstop' });
    const { rows } = matchStatement({
      transactions: [txn({ description: 'FIVE POINTS WINGSTOP RENT' })],
      propertyId: 'prop-1', tenants: [pershing],
    });
    expect(rows[0].candidate.property_id).toBe('prop-9');
  });

  it('majority vote flags a statement whose deposits belong to another property', () => {
    const pershingTenant = (n) => cityDental({ lease_id: `L${n}`, property_id: 'prop-9', property_name: 'Pershing Plaza', tenant_name: `Tenant ${n}` });
    const tenants = [1, 2, 3].map(pershingTenant);
    const { propertyVote } = matchStatement({
      transactions: tenants.map((t, i) => txn({ description: `CHECK TENANT ${i + 1}`, line: i + 1 })),
      propertyId: 'prop-1', tenants,
    });
    expect(propertyVote).toMatchObject({ propertyId: 'prop-9', propertyName: 'Pershing Plaza', count: 3, total: 3 });
  });

  it('no vote banner when the deposits agree with the page', () => {
    const { propertyVote } = matchStatement({
      transactions: [txn(), txn({ description: 'CITY DENTAL ACH', line: 3, date: '2026-06-02' })],
      propertyId: 'prop-1', tenants: [cityDental()],
    });
    expect(propertyVote).toBe(null);
  });
});

describe('findMatchingRule (extracted rule loop)', () => {
  const rules = [
    { pattern: 'CITY DENTAL PC', target_kind: 'tenant', lease_id: 'lease-2' },
    { pattern: 'HOME DEPOT', target_kind: 'expense_cam', cam_label: 'Repairs' },
  ];
  it('matches a contained pattern in the right direction', () => {
    expect(findMatchingRule(rules, txn())).toMatchObject({ lease_id: 'lease-2' });
    expect(findMatchingRule(rules, txn({ description: 'HOME DEPOT 55 SUPPLIES', direction: 'out', amount: 240 }))).toMatchObject({ target_kind: 'expense_cam' });
  });
  it('respects direction — a tenant rule never fires on money OUT', () => {
    expect(findMatchingRule(rules, txn({ direction: 'out' }))).toBe(null);
  });
  it('a too-short pattern (<3 chars) never matches', () => {
    expect(findMatchingRule([{ pattern: 'PC', target_kind: 'tenant', lease_id: 'x' }], txn())).toBe(null);
  });
  it('returns null when nothing matches', () => {
    expect(findMatchingRule(rules, txn({ description: 'RANDOM DEPOSIT' }))).toBe(null);
  });
});

describe('findMatchingRule — account-hint two-pass', () => {
  // Same payee pattern learned on two different accounts.
  const rules = [
    { pattern: 'DENTAL', target_kind: 'tenant', lease_id: 'A', account_hint: '••1111' },
    { pattern: 'DENTAL', target_kind: 'tenant', lease_id: 'B', account_hint: '••4821' },
  ];
  it('a hint-matching rule wins even when listed later', () => {
    expect(findMatchingRule(rules, txn(), '••4821')).toMatchObject({ lease_id: 'B' });
  });
  it('no hint → first-match fallback (unchanged 2-arg behavior)', () => {
    expect(findMatchingRule(rules, txn())).toMatchObject({ lease_id: 'A' });
    expect(findMatchingRule(rules, txn(), null)).toMatchObject({ lease_id: 'A' });
  });
  it('an unknown hint falls through to any pattern match', () => {
    expect(findMatchingRule(rules, txn(), '••9999')).toMatchObject({ lease_id: 'A' });
  });
  it('a hint-less (null) rule still matches in pass 2 when a hint is given', () => {
    const r = [{ pattern: 'DENTAL', target_kind: 'tenant', lease_id: 'C', account_hint: null }];
    expect(findMatchingRule(r, txn(), '••4821')).toMatchObject({ lease_id: 'C' });
  });
});

describe('escalation-aware corroboration & delta', () => {
  it('stepAtOrBefore returns the latest step at/before a month, null otherwise', () => {
    const steps = [{ month: 6, base: 2160.20, prevBase: 2106.08 }];
    expect(stepAtOrBefore(steps, 5)).toBe(null);
    expect(stepAtOrBefore(steps, 6)).toMatchObject({ month: 6 });
    expect(stepAtOrBefore(steps, 9)).toMatchObject({ month: 6 });
    expect(stepAtOrBefore([], 6)).toBe(null);
    // Twice-stepped year → the most recent applicable step.
    const two = [{ month: 4, base: 1, prevBase: 0 }, { month: 9, base: 2, prevBase: 1 }];
    expect(stepAtOrBefore(two, 7)).toMatchObject({ month: 4 });
    expect(stepAtOrBefore(two, 10)).toMatchObject({ month: 9 });
  });

  it('a deposit at the PRE-raise rate on a post-step open month → corroborated + escalated', () => {
    // Jan–May paid; June (post-step) open. A $4,106.08 check (the old rate) is the raise
    // not yet paid at the new amount — matched to June, flagged escalated (not "short").
    const t = stepped({ coverage: [4106.08, 4106.08, 4106.08, 4106.08, 4106.08, 0, 0, 0, 0, 0, 0, 0] });
    expect(corroborateAmount(4106.08, t)).toEqual({ corroborated: true, month: 6, toRecon: false, escalated: true });
  });
  it('a pre-step month still open → normal single-month match, no escalated flag', () => {
    const c = corroborateAmount(4106.08, stepped()); // firstOpen = Jan, owed 4106.08
    expect(c).toMatchObject({ corroborated: true, month: 1 });
    expect(c.escalated).toBeUndefined();
  });
  it('a k-month gap-sum spanning the step boundary stays untagged (no false escalation)', () => {
    // Jan+Feb = 4106.08 × 2; matched as a lump, month null, not escalated.
    const c = corroborateAmount(round(4106.08 * 2), stepped());
    expect(c).toMatchObject({ corroborated: true, month: null });
    expect(c.escalated).toBeUndefined();
  });
  it('short for OTHER reasons on a post-step month → not corroborated', () => {
    const t = stepped({ coverage: [4106.08, 4106.08, 4106.08, 4106.08, 4106.08, 0, 0, 0, 0, 0, 0, 0] });
    expect(corroborateAmount(3000, t).corroborated).toBe(false); // neither new, gap, nor pre-step rate
  });

  it('depositProjectionDelta carries an escalation marker at the pre-raise rate', () => {
    expect(depositProjectionDelta(4106.08, stepped(), 6)).toEqual({
      projected: 4160.20, delta: -54.12, escalation: { stepMonth: 6, prevOwed: 4106.08 },
    });
  });
  it('null-invariants still hold on a STEPPED tenant; a random short omits the escalation key', () => {
    expect(depositProjectionDelta(4160.20, stepped(), 6)).toBe(null); // full new rate
    const partial = stepped({ coverage: [0, 0, 0, 0, 0, 2160.20, 0, 0, 0, 0, 0, 0] });
    expect(depositProjectionDelta(2000, partial, 6)).toBe(null);      // gap top-up
    expect(depositProjectionDelta(4000, stepped(), 6)).toEqual({ projected: 4160.20, delta: -160.20 }); // no escalation key
  });

  it('matchStatement: a stepped tenant + pre-step deposit → high, checked, tagged to the step month', () => {
    const t = stepped({ coverage: [4106.08, 4106.08, 4106.08, 4106.08, 4106.08, 0, 0, 0, 0, 0, 0, 0] });
    const { rows } = matchStatement({
      transactions: [txn({ description: 'ACH SAM NAILS 5521', amount: 4106.08 })],
      propertyId: 'prop-3', tenants: [t],
    });
    expect(rows[0]).toMatchObject({ kind: 'tenant', confidence: 'high', checked: true, month: 6 });
  });

  it('matchStatement threads accountHint so a hinted rule wins', () => {
    const rules = [
      { pattern: 'DENTAL', target_kind: 'tenant', lease_id: 'A', account_hint: '••1111' },
      { pattern: 'DENTAL', target_kind: 'tenant', lease_id: 'B', account_hint: '••4821' },
    ];
    const t = cityDental({ lease_id: 'B', tenant_name: 'City Dental' });
    const { rows } = matchStatement({ transactions: [txn()], propertyId: 'prop-1', tenants: [t], rules, accountHint: '••4821' });
    expect(rows[0].confidence).toBe('rule');
    expect(rows[0].candidate.lease_id).toBe('B');
  });

  function round(n) { return Math.round(n * 100) / 100; }
});

describe('depositProjectionDelta (rent-mismatch at review)', () => {
  const t = cityDental({ owed: flat(9150), coverage: flat(0), monthly: 9150 });
  it('flags a short deposit against the month it is applied to', () => {
    expect(depositProjectionDelta(8000, t, 3)).toEqual({ projected: 9150, delta: -1150 });
  });
  it('flags an over deposit (positive delta)', () => {
    expect(depositProjectionDelta(9500, t, 3)).toEqual({ projected: 9150, delta: 350 });
  });
  it('within ±$1/1% of the projection → null (a "confident" match never flags)', () => {
    expect(depositProjectionDelta(9155, t, 3)).toBe(null); // 55 < 1% of 9150 (91.5)
    expect(depositProjectionDelta(9150, t, 3)).toBe(null);
  });
  it('matching the month\'s remaining GAP (a legitimate top-up) → null', () => {
    const partial = cityDental({ owed: flat(9150), coverage: [9150, 9150, 4150, 0, 0, 0, 0, 0, 0, 0, 0, 0], monthly: 9150 });
    expect(depositProjectionDelta(5000, partial, 3)).toBe(null); // gap = 9150 − 4150 = 5000
  });
  it('no month, or a month that bills nothing → null', () => {
    expect(depositProjectionDelta(8000, t, null)).toBe(null);
    expect(depositProjectionDelta(8000, t, 0)).toBe(null);
    const midYear = cityDental({ owed: [0, 0, 0, 0, 0, 0, 3000, 3000, 3000, 3000, 3000, 3000] });
    expect(depositProjectionDelta(8000, midYear, 1)).toBe(null); // January owes nothing
  });
});
