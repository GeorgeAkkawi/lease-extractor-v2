// Year-close collection history (Rent Ledger Stage 3): closeYear freezes each
// tenant's projected / collected / collection_rate / collected_by_month into the
// snapshot breakdown, and the pure selectors read them back for History. Runs
// against the demo mock (DEMO mode forced by the test env).
//
// Demo seed: prop-1 — Bright Coffee's inv-1 ($78,100) settled by one untagged
// lump; City Dental's inv-2 ($98,500) with Jan+Feb tagged ($8,208.33 each) + a
// $4,000 untagged partial = $20,416.66 collected.
import { describe, it, expect } from 'vitest';
import { closeYear } from '../api';
import { snapshotCollectionSummary, collectionSeries } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

describe('closeYear — the frozen collection picture', () => {
  it('writes projected/collected/rate/by-month per tenant; a lump payer reads rate 1.0', async () => {
    const snap = await closeYear('prop-1', Y);
    const coffee = snap.breakdown.find((b) => b.tenant === 'Bright Coffee Co.');
    // Projected now builds from the data (base 60,000 + est CAM&tax 16,500 + roof 1,500 = 78,000),
    // the same figure the invoice bills — the lump settles it exactly → rate 1.0.
    expect(coffee.projected).toBe(78000);
    expect(coffee.collected).toBe(78000);
    expect(coffee.collection_rate).toBe(1);
    expect(coffee.collected_by_month).toHaveLength(12);
    expect(round2(coffee.collected_by_month.reduce((s, n) => s + n, 0))).toBe(78000);
    const dental = snap.breakdown.find((b) => b.tenant === 'City Dental');
    expect(dental.projected).toBe(109800); // 84,000 base + 25,800 actual CAM&tax share
    expect(dental.collected).toBe(22300);  // 9,150 + 9,150 + 4,000
    expect(dental.collection_rate).toBeCloseTo(0.203, 3);
    // The classic breakdown fields are still there untouched.
    expect(dental.square_footage).toBe(3000);
  });

  it('the property summary + YoY series read back; key-less snapshots are skipped, never NaN', async () => {
    const snap = await closeYear('prop-1', Y);
    const sum = snapshotCollectionSummary(snap);
    expect(sum.projected).toBe(187800); // 78,000 + 109,800
    expect(sum.collected).toBe(100300); // 78,000 + 22,300
    expect(sum.rate).toBeCloseTo(0.534, 3);
    // A pre-ledger snapshot (no collection keys) → null summary.
    expect(snapshotCollectionSummary({ breakdown: [{ tenant: 'Old Co', base_rent: 1 }] })).toBe(null);
    expect(snapshotCollectionSummary(null)).toBe(null);
    const series = collectionSeries([
      { year: Y, breakdown: snap.breakdown },
      { year: Y - 2, breakdown: [] },                       // pre-ledger — skipped
      { year: Y - 1, breakdown: [{ tenant: 'T', projected: 100, collected: 96 }] },
    ]);
    expect(series.map((s) => s.year)).toEqual([Y - 1, Y]); // sorted, key-less skipped
    expect(series[0].rate).toBeCloseTo(0.96, 5);
  });
});
