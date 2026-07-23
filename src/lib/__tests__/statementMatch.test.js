// Statement matching — rule precedence, tenant fuzzy + amount corroboration,
// month suggestion vs the FIFO pool, the duplicate guard, the hand-entry
// collision flag, the withdrawal keyword table, and the majority-vote property
// detector. All pure, suggest-only.
import { describe, it, expect } from 'vitest';
import {
  normalizeDesc, lineHash, tenantNameScore, amountMatches, suggestRulePattern,
  classifyWithdrawal, corroborateAmount, rankDepositCandidates, matchStatement,
  findMatchingRule, depositProjectionDelta,
} from '../statementMatch';

const flat = (n) => Array(12).fill(n);
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
  it('suggestRulePattern picks the longest digit-free run — check numbers change monthly', () => {
    expect(suggestRulePattern('CHECK 1044 CITY DENTAL PC')).toBe('CITY DENTAL PC');
    expect(suggestRulePattern('ACH A HEGAZY 2211')).toBe('ACH A HEGAZY');
    expect(suggestRulePattern('12 34 56')).toBe(null); // nothing rule-worthy
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
