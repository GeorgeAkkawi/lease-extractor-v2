// Slice 7b — the 1099 worksheet.
//
// The expensive failures here are the opposite of round 11's, and that asymmetry is the
// thing to protect:
//   ① DROPPING A VENDOR. A form never filed costs $60–$680. So anything Amlak cannot
//      rule out must stay a CANDIDATE — an unknown category is a question, not an
//      exclusion. (Round 11 refuses the other way: an unclassifiable closing charge is
//      never basis, because guessing toward basis overstates what you own.)
//   ② DOUBLE-REPORTING. A card or payment-app charge is on the processor's 1099-K
//      already. Counting it toward the threshold can push a vendor over a line they
//      never crossed with money you are responsible for.
//   ③ ASSERTING WHAT ONLY A W-9 ANSWERS. Whether a vendor is incorporated is not
//      Amlak's to know, so nothing here decides it.
//
// These are pinned in both directions.
import { describe, it, expect } from 'vitest';
import {
  thresholdFor, THRESHOLDS, treatmentFor, VENDOR_TREATMENTS, paidByCard, vendorKey,
  vendorRowsFor, worksheet, EFILE_AT,
} from '../form1099';
import { EXPENSE_CATEGORIES } from '../expenseCategories';

const Y = 2026;
const PROP = { id: 'p1', name: 'Pershing Plaza' };

const run = (opts = {}) => {
  const part = vendorRowsFor({ property: PROP, year: Y, ...opts });
  return worksheet({
    vendors: part.vendors,
    unattributed: part.unattributed,
    skipped: part.skipped,
    draws: opts.draws || [],
    entityCosts: opts.entityCosts || [],
    year: Y,
    threshold: opts.threshold ?? 600,
  });
};
const byName = (list, name) => list.find((v) => v.name === name);

describe('the threshold is a line across the list, never a gate on it', () => {
  it('knows both figures and which year each applies to', () => {
    expect(thresholdFor(2024)).toBe(600);
    expect(thresholdFor(2025)).toBe(600);
    // Raised for payments made after 31 December 2025.
    expect(thresholdFor(2026)).toBe(2000);
    expect(thresholdFor(2030)).toBe(2000);
    expect(THRESHOLDS.length).toBeGreaterThan(1);
  });

  // ⚠ THE POINT. The threshold that applies may not be the one used, so a vendor under
  // it is still RETURNED — listed and counted, just below the line. Hiding it behind a
  // number that might be wrong is how a required filing gets missed.
  it('returns the vendors below it rather than dropping them', () => {
    const w = run({
      items: [
        { id: 'a', kind: 'cam', label: 'Landscaping', amount: 5000 },
        { id: 'b', kind: 'cam', label: 'Snow removal', amount: 400 },
      ],
      threshold: 600,
    });
    expect(w.candidates.map((v) => v.name)).toEqual(['Landscaping']);
    expect(w.below.map((v) => v.name)).toEqual(['Snow removal']);
    expect(w.counts.below).toBe(1);
    // Nothing vanished.
    expect(w.candidates.length + w.below.length + w.excluded.length).toBe(2);
  });
});

describe('what kind of payment it was', () => {
  it('every tax category resolves to a treatment', () => {
    for (const c of EXPENSE_CATEGORIES) {
      expect(treatmentFor(c.key), `category ${c.key}`).toBeTruthy();
    }
  });

  // The standing refusal — but note it does NOT make the row inert here.
  it('an unknown category key returns null', () => {
    expect(treatmentFor('crypto_mining')).toBeNull();
    expect(treatmentFor(undefined)).toBeNull();
    expect(treatmentFor(null)).toBeNull();
  });

  // ⚠ ①. Uncategorized money is a QUESTION, not an exclusion.
  it('a vendor with no category is a candidate, and says it needs one', () => {
    const w = run({ items: [{ id: 'a', kind: 'cam', label: 'Security', amount: 6000 }] });
    const v = byName(w.candidates, 'Security');
    expect(v).toBeTruthy();
    expect(v.report).toBe('ask');
    expect(v.needsCategory).toBe(true);
    expect(w.counts.needsCategory).toBe(1);
    expect(w.excluded).toHaveLength(0);
  });

  it('utilities, taxes, supplies, wages and depreciation are excluded WITH a reason', () => {
    const buckets = [
      { label: 'Comcast', category: 'utilities' },
      { label: 'County treasurer', category: 'taxes' },
      { label: 'Hardware store', category: 'supplies' },
      { label: 'Site staff', category: 'wages' },
    ];
    const w = run({
      buckets,
      items: [
        { id: 'a', kind: 'cam', label: 'Comcast', amount: 9000 },
        { id: 'b', kind: 'cam', label: 'County treasurer', amount: 40000 },
        { id: 'c', kind: 'cam', label: 'Hardware store', amount: 3000 },
        { id: 'd', kind: 'cam', label: 'Site staff', amount: 20000 },
      ],
    });
    expect(w.candidates).toHaveLength(0);
    expect(w.excluded).toHaveLength(4);
    for (const v of w.excluded) {
      expect(v.report).toBe('no');
      expect(v.treatment?.why).toBeTruthy(); // never excluded silently
    }
  });

  // ⚠ THE MOST COMMONLY MISSED 1099 THERE IS. An attorney is reported even when the firm
  // IS incorporated — the exemption every other corporation gets does not apply.
  it('legal fees are reported even if incorporated', () => {
    const w = run({
      buckets: [{ label: 'Hegazy & Partners LLP', category: 'legal' }],
      items: [{ id: 'a', kind: 'cam', label: 'Hegazy & Partners LLP', amount: 4200 }],
    });
    const v = byName(w.candidates, 'Hegazy & Partners LLP');
    expect(v.report).toBe('always');
    expect(v.treatment.key).toBe('attorney');
    expect(v.treatment.why).toMatch(/incorporated/i);
    // And it is NOT the same standing as an ordinary services vendor.
    expect(VENDOR_TREATMENTS.find((t) => t.key === 'ask').report).toBe('ask');
  });

  // One vendor paid into two buckets, one of them miscategorized as a utility, takes
  // the MORE reportable of the two — half a reportable relationship is still reportable,
  // and the safe direction is to ask.
  it('one payee across two buckets takes the most reportable category', () => {
    const w = run({
      rules: [
        { pattern: 'ACME SERVICES', target_kind: 'expense_cam', cam_label: 'Phone' },
        { pattern: 'ACME SERVICES', target_kind: 'expense_cam', cam_label: 'Repairs' },
      ],
      buckets: [
        { label: 'Phone', category: 'utilities' },   // → excluded on its own
        { label: 'Repairs', category: 'repairs' },   // → ask
      ],
      items: [
        { id: 'a', kind: 'cam', label: 'Phone', amount: 900 },
        { id: 'b', kind: 'cam', label: 'Repairs', amount: 900 },
      ],
    });
    const v = byName(w.candidates, 'ACME SERVICES');
    expect(v).toBeTruthy();
    expect(v.report).toBe('ask');
    expect(v.total).toBe(1800);
    expect(w.excluded).toHaveLength(0);
  });
});

describe('how it was paid', () => {
  it('recognizes a card or payment-app rail, on word boundaries', () => {
    expect(paidByCard('Debit Purchase - VISA APEX ROOFING On 041226')).toBe(true);
    expect(paidByCard('POS PURCHASE HOME DEPOT')).toBe(true);
    expect(paidByCard('PAYPAL *GREENLEAF')).toBe(true);
    expect(paidByCard('ZELLE TO A CONTRACTOR')).toBe(true);
    // A cheque or ACH is yours to report.
    expect(paidByCard('CHECK 1044 APEX ROOFING')).toBe(false);
    expect(paidByCard('Electronic Withdrawal To WASTE MANAGEMENT')).toBe(false);
    // ⚠ The round-7 lesson: a substring match would read CARDINAL as a card.
    expect(paidByCard('CHECK 1102 CARDINAL PLUMBING')).toBe(false);
    expect(paidByCard('ACH DISCOVERY LANDSCAPING')).toBe(false);
    expect(paidByCard('')).toBe(false);
  });

  // ⚠ ② THE HEADLINE. $3,000 paid, $1,200 of it by card → only $1,800 counts toward the
  // threshold, because the processor already reports the card portion on a 1099-K.
  it('only the non-card portion counts toward the threshold', () => {
    const items = [
      { id: 'a', kind: 'cam', label: 'Apex Roofing', amount: 1800 },
      { id: 'b', kind: 'cam', label: 'Apex Roofing', amount: 1200 },
    ];
    const lines = [
      { ref_id: 'a', description: 'CHECK 1044 APEX ROOFING' },
      { ref_id: 'b', description: 'Debit Purchase - VISA APEX ROOFING On 041226' },
    ];
    const w = run({ items, lines, threshold: 2000 });
    const v = byName(w.below, 'Apex Roofing') || byName(w.candidates, 'Apex Roofing');
    expect(v.total).toBe(3000);
    expect(v.cardTotal).toBe(1200);
    expect(v.reportable).toBe(1800);
    // The whole point: $3,000 would have crossed $2,000. $1,800 does not.
    expect(v.crosses).toBe(false);
    expect(w.candidates).toHaveLength(0);
    expect(w.leftOff.cardTotal).toBe(1200);
  });

  // Round 6's audit rows are forward-only, so most money has no method on record. That
  // must read as UNKNOWN and be reported, never assumed to be a cheque.
  it('reports how many candidates have no payment method on record', () => {
    const w = run({ items: [{ id: 'a', kind: 'cam', label: 'Landscaping', amount: 5000 }], lines: [] });
    const v = byName(w.candidates, 'Landscaping');
    expect(v.methodKnown).toBe(false);
    expect(w.counts.noMethod).toBe(1);
  });
});

describe('who was paid, and how far to trust the name', () => {
  it('merges one vendor under two spellings', () => {
    expect(vendorKey('Groot, Inc.')).toBe(vendorKey('GROOT INC'));
    const w = run({
      contracts: [{ id: 'c1', vendor: 'Groot, Inc.', name: 'Garbage' }],
      items: [
        { id: 'a', kind: 'cam', label: 'Garbage', amount: 6600, contract_id: 'c1' },
        { id: 'b', kind: 'cam', label: 'GROOT INC', amount: 6600 },
      ],
    });
    const v = byName(w.candidates, 'Groot, Inc.');
    expect(v.total).toBe(13200);
    expect(v.count).toBe(2);
  });

  // ⚠ ③'s sibling. A bucket label is NOT a payee — "Repairs" can cover three
  // contractors — so a bucket-derived name says so, and a real vendor name outranks it.
  it('a contract vendor and a learned payee outrank a bucket label', () => {
    const w = run({
      contracts: [{ id: 'c1', vendor: 'Groot, Inc.', name: 'Garbage' }],
      rules: [
        { pattern: 'OTIS ELEVATOR', target_kind: 'expense_cam', cam_label: 'Elevator service' },
        // A TENANT rule names who paid YOU — it must never become a vendor.
        { pattern: 'CITY DENTAL', target_kind: 'tenant', cam_label: null },
      ],
      items: [
        { id: 'a', kind: 'cam', label: 'Garbage', amount: 5000, contract_id: 'c1' },
        { id: 'b', kind: 'cam', label: 'Elevator service', amount: 4000 },
        { id: 'c', kind: 'cam', label: 'Repairs', amount: 3000 },
      ],
    });
    expect(byName(w.candidates, 'Groot, Inc.').source).toBe('contract');
    expect(byName(w.candidates, 'Groot, Inc.').precise).toBe(true);
    expect(byName(w.candidates, 'OTIS ELEVATOR').source).toBe('rule');
    const bucket = byName(w.candidates, 'Repairs');
    expect(bucket.source).toBe('bucket');
    expect(bucket.precise).toBe(false);
    expect(w.counts.imprecise).toBe(1);
    expect(byName(w.candidates, 'CITY DENTAL')).toBeUndefined();
  });

  // syncContractCamItems writes a derived line per covering contract, so summing the
  // contract's own annual cost ON TOP of it would bill Groot twice.
  it('a contract that already produced a line is not counted twice', () => {
    const contracts = [{ id: 'c1', vendor: 'Groot, Inc.', name: 'Garbage', amount: 1100, frequency: 'monthly', start_date: '2020-01-01', end_date: null }];
    const w = run({ contracts, items: [{ id: 'a', kind: 'cam', label: 'Garbage', amount: 13200, contract_id: 'c1' }] });
    expect(byName(w.candidates, 'Groot, Inc.').total).toBe(13200);
  });

  it('but a contract with no line of its own is still listed', () => {
    const contracts = [{ id: 'c1', vendor: 'Groot, Inc.', name: 'Garbage', amount: 1100, frequency: 'monthly', start_date: '2020-01-01', end_date: null }];
    const w = run({ contracts, items: [] });
    expect(byName(w.candidates, 'Groot, Inc.').total).toBe(13200);
  });
});

describe('what is deliberately left off, and why', () => {
  // ⚠ A capital cost being written off is a BOOK entry. The money left in the year the
  // asset was bought and was reportable then; counting it again every year of its life
  // would invent a vendor payment that never happened.
  it('an amortized capital cost is not a payment this year', () => {
    const w = run({
      items: [
        { id: 'a', kind: 'roof', label: 'Roof — amortized', amount: 4000, asset_id: 'asset-1' },
        { id: 'b', kind: 'cam', label: 'Landscaping', amount: 5000 },
      ],
    });
    expect(byName(w.candidates, 'Roof — amortized')).toBeUndefined();
    expect(w.candidates).toHaveLength(1);
    expect(w.leftOff.capital).toBe(4000);
    expect(w.leftOff.capitalRows[0].why).toMatch(/year it was bought/i);
  });

  // Round 7's distinction, carried onto the form: a distribution is not a payment for
  // services, so it is NAMED on the left-off list rather than silently absent.
  it('a draw is never a vendor, and is named rather than dropped', () => {
    const w = run({
      items: [{ id: 'a', kind: 'cam', label: 'Landscaping', amount: 5000 }],
      draws: [{ amount: 24000 }, { amount: 5000 }],
    });
    expect(w.candidates).toHaveLength(1);
    expect(w.leftOff.draws).toBe(29000);
    expect(w.leftOff.drawCount).toBe(2);
  });

  // ⚠ A flat un-itemized total has no payee attached to ANY part of it, so it cannot be
  // tested against the threshold. Silence would read as "nothing to report" when the
  // truth is "nobody knows". Round 5's rule, reused.
  it('an un-itemized yearly figure is reported as unattributable', () => {
    const w = run({
      items: [{ id: 'a', kind: 'cam', label: 'Landscaping', amount: 5000 }],
      expense: { taxes_total: 127000, cam_total: 5000, roof_total: 0 },
    });
    expect(w.leftOff.unattributed).toBe(127000);
  });

  it('but an itemized kind is complete, so nothing is unattributed', () => {
    const w = run({
      items: [
        { id: 'a', kind: 'tax', label: 'County — 1st', amount: 60000 },
        { id: 'b', kind: 'tax', label: 'County — 2nd', amount: 67000 },
      ],
      expense: { taxes_total: 127000, cam_total: 0, roof_total: 0 },
    });
    expect(w.leftOff.unattributed).toBe(0);
  });
});

describe('the filing facts it reports', () => {
  it('flags the e-file threshold once there are enough returns', () => {
    const items = Array.from({ length: EFILE_AT }, (_, i) => ({ id: `v${i}`, kind: 'cam', label: `Vendor ${i}`, amount: 5000 }));
    expect(run({ items }).counts.efile).toBe(true);
    expect(run({ items: items.slice(0, EFILE_AT - 1) }).counts.efile).toBe(false);
  });

  it('ranks by what actually counts toward the threshold', () => {
    const w = run({
      items: [
        { id: 'a', kind: 'cam', label: 'Small', amount: 900 },
        { id: 'b', kind: 'cam', label: 'Large', amount: 9000 },
        { id: 'c', kind: 'cam', label: 'Middle', amount: 3000 },
      ],
    });
    expect(w.candidates.map((v) => v.name)).toEqual(['Large', 'Middle', 'Small']);
  });
});

describe('it does not mutate its inputs', () => {
  it('leaves every argument untouched', () => {
    const items = [{ id: 'a', kind: 'cam', label: 'Landscaping', amount: 5000 }];
    const buckets = [{ label: 'Landscaping', category: 'cleaning' }];
    const rules = [{ pattern: 'GREENLEAF', target_kind: 'expense_cam', cam_label: 'Landscaping' }];
    const before = JSON.stringify({ items, buckets, rules });
    run({ items, buckets, rules });
    expect(JSON.stringify({ items, buckets, rules })).toBe(before);
  });
});
