// Statement import end-to-end against the demo mock (DEMO mode forced by the test
// env): context assembly → matching → apply → the dedupe guard on a re-upload →
// the "import anyway" override → undo restoring exactly (including the clamped
// expense decrement and the hand-deleted-payment tolerance) → re-apply landing the
// same figures once. Also the recon-invoice path (no month tag, monthly coverage
// untouched) and the import_rules 23505 reuse.
//
// Demo seed (store.js), year Y: prop-1 Maple Plaza — Bright Coffee (lease-1,
// inv-1 settled by an untagged lump) + City Dental (lease-2, inv-2 $98,500 with
// Jan/Feb tagged and a $4,000 untagged partial pooling onto March). Expense
// record exp-1 (prop-1, Y): taxes 25,000 · CAM 18,000 (3 items) · roof 4,000.
import { describe, it, expect } from 'vitest';
import {
  getStatementMatchContext, applyStatementImport, undoStatementImport,
  listStatementImports, saveImportRule, listImportRules,
  getExpenseRecord, listCamLineItems, listPayments, deletePayment,
  createInvoice, listInvoices, getPropertyMonthlyRoll,
} from '../api';
import { matchStatement, lineHash } from '../statementMatch';
import { allocatePayments } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const cityDentalCheck = { date: `${Y}-05-02`, description: 'CHECK 1044 CITY DENTAL PC', amount: 8208.33, direction: 'in', balance: null, line: 2 };
const taxLine = { date: `${Y}-05-12`, description: 'COOK COUNTY TREASURER PROP TAX', amount: 3100, direction: 'out', balance: null, line: 3 };
const camLine = { date: `${Y}-05-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 4 };

const paymentEntry = (txn, over = {}) => ({
  type: 'payment', lease_id: 'lease-2', property_id: 'prop-1', year: Y,
  amount: txn.amount, date: txn.date, description: txn.description,
  period_month: null, reconInvoiceId: null, hash: lineHash(txn), ...over,
});

describe('statement import — apply / dedupe / override / undo', () => {
  it('context assembles the whole portfolio + matching books the check to its gap month', async () => {
    const ctx = await getStatementMatchContext('prop-1', Y);
    // Tenants from BOTH properties (cross-property routing).
    expect(ctx.tenants.some((t) => t.property_id === 'prop-2')).toBe(true);
    expect(ctx.existingHashes.size).toBe(0); // nothing imported yet
    const { rows: matched } = matchStatement({ transactions: [cityDentalCheck, taxLine, camLine], propertyId: 'prop-1', tenants: ctx.tenants, rules: ctx.rules, existingHashes: ctx.existingHashes });
    expect(matched[0]).toMatchObject({ kind: 'tenant', confidence: 'high' });
    expect(matched[0].candidate.lease_id).toBe('lease-2');
    // Jan+Feb tagged, the $4,000 pool part-covers March → earliest uncovered = March.
    expect(matched[0].month).toBe(3);
    expect(matched[1].kind).toBe('expense_tax');
    expect(matched[2]).toMatchObject({ kind: 'expense_cam', label: 'Landscaping' });
  });

  it('apply writes the payment (hashed), the CAM item (synced), and accumulates taxes — all recorded in `applied`', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'may.csv', accountHint: '••4821',
      entries: [
        paymentEntry(cityDentalCheck, { period_month: 5 }),
        { type: 'cam', property_id: 'prop-1', year: Y, amount: 450, label: 'Landscaping', hash: lineHash(camLine) },
        { type: 'tax', property_id: 'prop-1', year: Y, amount: 3100, hash: lineHash(taxLine) },
      ],
    });
    expect(res.summary).toMatchObject({ paymentsCount: 1, expensesCount: 2 });
    const pays = await listPayments('inv-2');
    const imported = pays.find((p) => p.import_hash === lineHash(cityDentalCheck));
    expect(imported).toMatchObject({ amount: 8208.33, period_month: 5 });
    const exp = await getExpenseRecord('prop-1', Y);
    expect(Number(exp.taxes_total)).toBe(28100); // 25,000 + 3,100 — accumulated, not overwritten
    expect(Number(exp.cam_total)).toBe(18450);   // item sum re-synced
    const items = await listCamLineItems('prop-1', Y);
    expect(items.find((i) => i.label === 'Landscaping' && i.import_id)).toBeTruthy();
    expect(res.import.applied).toHaveLength(3);
    expect((await listStatementImports('prop-1'))[0].file_name).toBe('may.csv');
  });

  it('the next upload greys the same lines (hash guard) and remembers the account', async () => {
    const ctx = await getStatementMatchContext('prop-1', Y);
    expect(ctx.existingHashes.has(lineHash(cityDentalCheck))).toBe(true);
    expect(ctx.existingHashes.has(lineHash(taxLine))).toBe(true);
    expect(ctx.accountMemory['••4821']).toMatchObject({ property_id: 'prop-1' });
    const { rows: matched } = matchStatement({ transactions: [cityDentalCheck], propertyId: 'prop-1', tenants: ctx.tenants, existingHashes: ctx.existingHashes });
    expect(matched[0].duplicate).toBe(true);
    expect(matched[0].checked).toBe(false);
  });

  it('"import anyway" override writes — two identical legit checks stay possible', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'override.csv',
      entries: [paymentEntry(cityDentalCheck, { period_month: 6 })],
    });
    const pays = await listPayments('inv-2');
    expect(pays.filter((p) => p.import_hash === lineHash(cityDentalCheck))).toHaveLength(2);
    await undoStatementImport(res.import); // clean up the override
  });

  it('undo reverses exactly the import\'s delta — and its hashes leave the dedupe universe', async () => {
    const [imp] = await listStatementImports('prop-1');
    const { notes } = await undoStatementImport(imp);
    expect(notes).toHaveLength(0);
    const pays = await listPayments('inv-2');
    expect(pays.find((p) => p.import_hash === lineHash(cityDentalCheck))).toBeFalsy();
    const exp = await getExpenseRecord('prop-1', Y);
    expect(Number(exp.taxes_total)).toBe(25000);
    expect(Number(exp.cam_total)).toBe(18000);
    expect(await listStatementImports('prop-1')).toHaveLength(0);
    const ctx = await getStatementMatchContext('prop-1', Y);
    expect(ctx.existingHashes.has(lineHash(cityDentalCheck))).toBe(false);
  });

  it('apply → undo → re-apply lands the exact same figures once', async () => {
    const entries = [
      paymentEntry(cityDentalCheck, { period_month: 5 }),
      { type: 'tax', property_id: 'prop-1', year: Y, amount: 3100, hash: lineHash(taxLine) },
    ];
    const a = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'a.csv', entries });
    await undoStatementImport(a.import);
    const b = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'b.csv', entries });
    expect(Number((await getExpenseRecord('prop-1', Y)).taxes_total)).toBe(28100); // once, not twice
    expect((await listPayments('inv-2')).filter((p) => p.import_hash === lineHash(cityDentalCheck))).toHaveLength(1);
    await undoStatementImport(b.import);
  });

  it('undo tolerates a hand-deleted payment and clamps an edited-down expense at $0 with a note', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-2', year: Y, fileName: 'oak.csv',
      entries: [
        { type: 'payment', lease_id: 'lease-3', property_id: 'prop-2', year: Y, amount: 500, date: `${Y}-04-01`, description: 'NORTHWIND', period_month: null, reconInvoiceId: null, hash: 'h-oak-1' },
        { type: 'roof', property_id: 'prop-2', year: Y, amount: 9000, hash: 'h-oak-2' },
      ],
    });
    // The first-ever import Just Works: lease-3 had no invoice — ensureInvoice made one.
    const inv3 = (await listInvoices('lease-3')).find((i) => Number(i.year) === Y && i.status !== 'void');
    expect(inv3).toBeTruthy();
    // George hand-deletes the payment, then edits roof DOWN below the imported delta.
    const pay = (await listPayments(inv3.id)).find((p) => p.import_hash === 'h-oak-1');
    await deletePayment(pay.id);
    const { upsertExpenseRecord } = await import('../api');
    const cur = await getExpenseRecord('prop-2', Y);
    await upsertExpenseRecord({ property_id: 'prop-2', year: Y, taxes_total: Number(cur.taxes_total), cam_total: Number(cur.cam_total), roof_total: 4000 });
    const { notes } = await undoStatementImport(res.import);
    expect(notes.some((n) => n.includes('clamped'))).toBe(true);
    expect(Number((await getExpenseRecord('prop-2', Y)).roof_total)).toBe(0); // clamped, not −5,000
  });

  it('a reconciliation-invoice payment carries no month tag and leaves monthly coverage untouched', async () => {
    const recon = await createInvoice({
      lease_id: 'lease-1', property_id: 'prop-1', year: Y, status: 'sent',
      kind: 'reconciliation', total_amount: 985.04, due_date: `${Y}-12-31`,
    });
    const before = (await getPropertyMonthlyRoll('prop-1', Y)).find((r) => r.lease_id === 'lease-1');
    const covBefore = allocatePayments({ owedByMonth: before.schedule, payments: before.payments }).coverage;
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'recon.csv',
      entries: [{
        type: 'payment', lease_id: 'lease-1', property_id: 'prop-1', year: Y,
        amount: 985.04, date: `${Y}-06-01`, description: 'CHECK BRIGHT COFFEE TRUE UP',
        period_month: null, reconInvoiceId: recon.id, hash: 'h-recon-1',
      }],
    });
    const reconPays = await listPayments(recon.id);
    expect(reconPays).toHaveLength(1);
    expect(reconPays[0].period_month).toBeFalsy();
    const reconBal = (await listInvoices('lease-1')).find((i) => i.id === recon.id);
    expect(Number(reconBal.balance)).toBe(0); // the true-up reads collected ✓
    const after = (await getPropertyMonthlyRoll('prop-1', Y)).find((r) => r.lease_id === 'lease-1');
    const covAfter = allocatePayments({ owedByMonth: after.schedule, payments: after.payments }).coverage;
    expect(covAfter).toEqual(covBefore); // the grid never saw the true-up money
    await undoStatementImport(res.import);
  });

  it('saveImportRule reuses the existing rule on a duplicate pattern (23505 → update)', async () => {
    const first = await saveImportRule({ property_id: 'prop-1', pattern: 'HEGAZY', target_kind: 'tenant', lease_id: 'lease-2' });
    const second = await saveImportRule({ property_id: 'prop-1', pattern: 'hegazy', target_kind: 'tenant', lease_id: 'lease-1' });
    expect(second.id).toBe(first.id); // updated in place
    const rules = await listImportRules();
    expect(rules.filter((r) => r.pattern.toLowerCase() === 'hegazy')).toHaveLength(1);
    expect(rules.find((r) => r.id === first.id).lease_id).toBe('lease-1');
  });
});
