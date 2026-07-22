// Expense buckets (0064) against the demo mock: named buckets ride cam_line_items
// labels; billable=false ("not billed to tenants") rows are itemized but EXCLUDED
// from the CAM total, so they never touch tenant bills. Rules can remember a
// bucket (cam_label + the new expense_other kind), and the lease-stated estimate
// reader pulls the cached AI read for the Financials editor prefill.
//
// Demo seed: prop-1 CAM items Landscaping 8,000 + Snow removal 4,000 + Security
// 6,000 (billable) + Owner legal fees 1,200 (billable:false) — cam_total 18,000.
// City Dental (lease-2) has lease_file_id lf-1 whose extraction_raw states a
// $12,000/yr estimated CAM & tax; Bright Coffee (lease-1) has no lease file.
import { describe, it, expect } from 'vitest';
import {
  applyStatementImport, undoStatementImport, getStatementMatchContext,
  getExpenseRecord, listCamLineItems, addCamLineItem, deleteCamLineItem,
  saveImportRule, deleteImportRule, getLeaseStatedEstimate,
} from '../api';
import { matchStatement } from '../statementMatch';
import { currentYear } from '../format';

const Y = currentYear();

describe('expense buckets — billable vs not-billed', () => {
  it('a not-billed item is stored + listed but never sums into the CAM total', async () => {
    const before = await getExpenseRecord('prop-1', Y);
    expect(Number(before.cam_total)).toBe(18000); // the seeded 1,200 legal fees already excluded
    const item = await addCamLineItem({ property_id: 'prop-1', year: Y, label: 'Owner accounting', amount: 500, billable: false });
    expect(item.billable).toBe(false);
    const after = await getExpenseRecord('prop-1', Y);
    expect(Number(after.cam_total)).toBe(18000); // unchanged — not billed
    await deleteCamLineItem(item.id, 'prop-1', Y);
  });

  it('import writes bucket labels; only billable buckets grow the CAM total; undo reverses both', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'buckets.csv',
      entries: [
        { type: 'cam', property_id: 'prop-1', year: Y, amount: 380, label: 'Garbage', billable: true, hash: 'h-garbage' },
        { type: 'cam', property_id: 'prop-1', year: Y, amount: 212.48, label: 'Repairs & supplies', billable: false, hash: 'h-repairs' },
      ],
    });
    const items = await listCamLineItems('prop-1', Y);
    const garbage = items.find((it) => it.label === 'Garbage');
    const repairs = items.find((it) => it.label === 'Repairs & supplies');
    expect(garbage.billable).toBe(true);
    expect(repairs.billable).toBe(false);
    expect(res.import.applied.find((a) => a.label === 'Repairs & supplies').billable).toBe(false);
    // Only the billable bucket moved the CAM billed to tenants: 18,000 + 380.
    const mid = await getExpenseRecord('prop-1', Y);
    expect(Number(mid.cam_total)).toBe(18380);
    // Undo removes both items and re-syncs back to the seed figure.
    await undoStatementImport(res.import);
    const after = await getExpenseRecord('prop-1', Y);
    expect(Number(after.cam_total)).toBe(18000);
    const left = await listCamLineItems('prop-1', Y);
    expect(left.some((it) => it.label === 'Garbage' || it.label === 'Repairs & supplies')).toBe(false);
  });

  it('the match context serves the owner buckets, both kinds', async () => {
    const ctx = await getStatementMatchContext('prop-1', Y);
    expect(ctx.buckets).toContainEqual({ label: 'Landscaping', billable: true });
    expect(ctx.buckets).toContainEqual({ label: 'Owner legal fees', billable: false });
  });

  it('an expense_other rule suggests the not-billed bucket with its label', async () => {
    const line = { date: `${Y}-04-01`, description: 'ACME LEGAL SERVICES INV 33', amount: 900, direction: 'out', balance: null, line: 1 };
    const rule = { pattern: 'ACME LEGAL', target_kind: 'expense_other', lease_id: null, cam_label: 'Owner legal fees', property_id: 'prop-1' };
    const { rows } = matchStatement({ transactions: [line], propertyId: 'prop-1', tenants: [], rules: [rule], existingHashes: new Set() });
    expect(rows[0]).toMatchObject({ kind: 'expense_other', label: 'Owner legal fees', confidence: 'rule', checked: true });
  });

  it('a saved expense rule remembers its bucket (cam_label) and feeds the bucket list', async () => {
    const rule = await saveImportRule({ property_id: 'prop-1', pattern: 'WASTE MGMT', target_kind: 'expense_cam', cam_label: 'Garbage' });
    expect(rule.cam_label).toBe('Garbage');
    const ctx = await getStatementMatchContext('prop-1', Y);
    expect(ctx.buckets).toContainEqual({ label: 'Garbage', billable: true });
    const { rows } = matchStatement({
      transactions: [{ date: `${Y}-04-02`, description: 'WASTE MGMT GARBAGE SVC 55021', amount: 380, direction: 'out', balance: null, line: 1 }],
      propertyId: 'prop-1', tenants: [], rules: ctx.rules, existingHashes: new Set(),
    });
    expect(rows[0]).toMatchObject({ kind: 'expense_cam', label: 'Garbage', confidence: 'rule' });
    await deleteImportRule(rule.id);
  });
});

describe('lease-stated estimate reader (the editor prefill)', () => {
  it('reads the cached AI figure + quote; null when the lease has no cached read', async () => {
    const est = await getLeaseStatedEstimate('lease-2');
    expect(est.camTaxAnnual).toBe(12000);
    expect(est.quote).toMatch(/4\.00 per square foot/);
    expect(await getLeaseStatedEstimate('lease-1')).toBe(null);
  });
});
