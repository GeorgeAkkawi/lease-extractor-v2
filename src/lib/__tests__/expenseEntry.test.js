// The expense entry grows two things George asked for:
//
//  1. PROPERTY TAXES ARE ITEMIZED. "when taxes are pulled from the statement they
//     shouldnt upload to expenses rather to the property taxes box … a new line per
//     time it sees it on the statement … give it its own line item." A year's taxes
//     are two or three instalments, and one running total hides which was which.
//     The load-bearing safety property: itemizing must never LOSE the figure already
//     entered — the first $3,100 instalment must not re-sum a hand-typed $25,000 year
//     down to $3,100 and silently under-bill every tenant.
//
//  2. A MANAGEMENT FEE IS A PERCENTAGE, NOT A FIGURE. "add an option in the CAM total
//     entry as management fee … when it is clicked i need it to offer a percentage of
//     base rent as that calcuation then it needs to be added to the expenses."
import { describe, it, expect, afterEach } from 'vitest';
import {
  listCamLineItems, listTaxLineItems, addCamLineItem, addTaxLineItem,
  deleteCamLineItem, deleteTaxLineItem, getExpenseRecord, upsertExpenseRecord,
  syncRentPctCamItems, getPropertyTotals, updateLease, applyStatementImport, undoStatementImport,
} from '../api';
import { currentYear } from '../format';

const Y = currentYear();
const P = 'prop-1';
const SEED = { taxes_total: 25000, cam_total: 18000, roof_total: 4000 };

// Put the property back exactly as seeded, whatever a test did to it.
afterEach(async () => {
  for (const it of await listTaxLineItems(P, Y)) await deleteTaxLineItem(it.id, P, Y);
  for (const it of await listCamLineItems(P, Y)) if (it.rent_pct != null) await deleteCamLineItem(it.id, P, Y);
  await upsertExpenseRecord({ property_id: P, year: Y, ...SEED });
});

describe('property taxes — itemized, one line per payment', () => {
  it('carries a hand-entered year total into its own line, so the first instalment never shrinks the year', async () => {
    expect(await listTaxLineItems(P, Y)).toHaveLength(0);
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(25000);

    await addTaxLineItem({ property_id: P, year: Y, label: 'Cook County — 1st instalment', amount: 3100 });

    const items = await listTaxLineItems(P, Y);
    expect(items.map((it) => it.label).sort()).toEqual(['Cook County — 1st instalment', 'Entered by hand']);
    // The year is the SUM — the $25,000 already on file plus the new payment. Getting
    // this wrong bills every tenant off $3,100 of taxes instead of $28,100.
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(28100);
  });

  it('each payment is its own line, and removing one re-sums the year', async () => {
    await upsertExpenseRecord({ property_id: P, year: Y, ...SEED, taxes_total: 0 }); // nothing to carry
    const a = await addTaxLineItem({ property_id: P, year: Y, label: 'Cook County — 1st', amount: 12000 });
    await addTaxLineItem({ property_id: P, year: Y, label: 'Cook County — 2nd', amount: 12400 });
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(24400);

    await deleteTaxLineItem(a.id, P, Y);
    expect(await listTaxLineItems(P, Y)).toHaveLength(1);
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(12400);
  });

  it('tax lines stay out of CAM — the two lists never bleed into each other', async () => {
    await addTaxLineItem({ property_id: P, year: Y, label: 'Cook County', amount: 3100 });
    const cam = await listCamLineItems(P, Y);
    expect(cam.some((it) => it.label === 'Cook County')).toBe(false);
    // CAM's own total is untouched by a tax payment.
    expect(Number((await getExpenseRecord(P, Y)).cam_total)).toBe(18000);
  });
});

describe('an imported tax payment lands in the tax list, not in a running total', () => {
  it('books its own line named after the payee, and undo takes exactly that line back out', async () => {
    const entry = {
      type: 'tax', property_id: P, year: Y, amount: 3100,
      label: 'Cook County Treasurer', hash: 'h-tax-1',
    };
    const { import: imp } = await applyStatementImport({ propertyId: P, year: Y, fileName: 'may.csv', entries: [entry] });

    const items = await listTaxLineItems(P, Y);
    expect(items.map((it) => it.label).sort()).toEqual(['Cook County Treasurer', 'Entered by hand']);
    expect(items.find((it) => it.label === 'Cook County Treasurer').import_id).toBe(imp.id); // wears the "imported" badge
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(28100);

    await undoStatementImport(imp);
    // The imported line is gone; the carried-over figure — which was George's, not the
    // import's — stays, and the year reads exactly what it did before.
    expect((await listTaxLineItems(P, Y)).map((it) => it.label)).toEqual(['Entered by hand']);
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(25000);
  });
});

describe('management fee — a percentage of base rent', () => {
  it('bills the dollars the percentage works out to, and says what it was struck at', async () => {
    const totals = await getPropertyTotals(P, Y);
    const rent = Number(totals.total_revenue);
    expect(rent).toBe(144000); // Bright Coffee $60,000 + City Dental $84,000

    const fee = await addCamLineItem({ property_id: P, year: Y, label: 'Management fee', amount: 7200, rent_pct: 5 });
    expect(Number(fee.amount)).toBe(7200);
    expect(Number(fee.rent_pct)).toBe(5);
    // It bills like any other CAM component.
    expect(Number((await getExpenseRecord(P, Y)).cam_total)).toBe(18000 + 7200);
  });

  it('follows the rent — a raise moves the fee without anyone re-typing it', async () => {
    await addCamLineItem({ property_id: P, year: Y, label: 'Management fee', amount: 7200, rent_pct: 5 });
    await updateLease('lease-1', { base_rent: 80000 }); // $60,000 → $80,000
    try {
      expect(await syncRentPctCamItems(P, Y)).toBe(true);
      const fee = (await listCamLineItems(P, Y)).find((it) => it.rent_pct != null);
      expect(Number(fee.amount)).toBe(8200); // 5% of $164,000
      expect(Number((await getExpenseRecord(P, Y)).cam_total)).toBe(18000 + 8200);
      // Idempotent — a second pass has nothing to do.
      expect(await syncRentPctCamItems(P, Y)).toBe(false);
    } finally {
      await updateLease('lease-1', { base_rent: 60000 });
    }
  });

  it('leaves a typed figure alone — only a percentage line follows the rent', async () => {
    const plain = await addCamLineItem({ property_id: P, year: Y, label: 'Landscaping', amount: 8000 });
    try {
      await syncRentPctCamItems(P, Y);
      const after = (await listCamLineItems(P, Y)).find((it) => it.id === plain.id);
      expect(Number(after.amount)).toBe(8000);
    } finally {
      await deleteCamLineItem(plain.id, P, Y);
    }
  });
});
