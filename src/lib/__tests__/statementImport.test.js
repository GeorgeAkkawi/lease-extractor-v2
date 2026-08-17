// Statement import end-to-end against the demo mock (DEMO mode forced by the test
// env): context assembly → matching → apply → the dedupe guard on a re-upload →
// the "import anyway" override → undo restoring exactly (re-summing an itemized
// expense from the lines that survive, and tolerating a hand-deleted payment) →
// re-apply landing the same figures once. Also the recon-invoice path (no month tag, monthly coverage
// untouched) and the import_rules 23505 reuse.
//
// Demo seed (store.js), year Y: prop-1 Maple Plaza — Bright Coffee (lease-1,
// inv-1 settled by an untagged lump) + City Dental (lease-2, inv-2 $98,500 with
// Jan/Feb tagged and a $4,000 untagged partial pooling onto March). Expense
// record exp-1 (prop-1, Y): taxes 25,000 (flat, un-itemized) · CAM 18,000
// (4 items, one not-billed) · roof 4,000 (2 items, 0074).
import { describe, it, expect } from 'vitest';
import {
  getStatementMatchContext, applyStatementImport, undoStatementImport,
  listStatementImports, saveImportRule, listImportRules, deleteImportRule,
  getExpenseRecord, listCamLineItems, listRoofLineItems, deleteRoofLineItem,
  listPayments, deletePayment,
  createInvoice, listInvoices, getPropertyMonthlyRoll,
  listStatementLinesForYear, listUnplacedLines, deleteCamLineItem,
} from '../api';
import { matchStatement, lineHash } from '../statementMatch';
import { allocatePayments } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const cityDentalCheck = { date: `${Y}-05-02`, description: 'CHECK 1044 CITY DENTAL PC', amount: 9150, direction: 'in', balance: null, line: 2 };
const taxLine = { date: `${Y}-05-12`, description: 'COOK COUNTY TREASURER PROP TAX', amount: 3100, direction: 'out', balance: null, line: 3 };
const camLine = { date: `${Y}-05-15`, description: 'GREENLEAF LANDSCAPING INV 88', amount: 450, direction: 'out', balance: null, line: 4 };

const paymentEntry = (txn, over = {}) => ({
  type: 'payment', lease_id: 'lease-2', property_id: 'prop-1', year: Y,
  amount: txn.amount, date: txn.date, description: txn.description,
  period_month: null, reconInvoiceId: null, hash: lineHash(txn), ...over,
});

// Regression (2026-07-23): getStatementMatchContext shipped with a single-arg
// .not('import_hash'), which postgrest-js turns into "import_hash=not.undefined
// .undefined" — a PostgREST 400. The demo mock's not() took one arg and read it
// as "is not null", so every test passed while live import hung forever on
// "Reading the statement…". The mock now mirrors the real (column, operator,
// value) signature and throws otherwise, so this assertion fails loudly if the
// malformed filter (or any sibling) ever comes back.
describe('statement import — context assembles with live-shaped filters', () => {
  it('getStatementMatchContext resolves (no malformed PostgREST filter)', async () => {
    const ctx = await getStatementMatchContext('prop-1', Y);
    expect(ctx.tenants.length).toBeGreaterThan(0);
    expect(ctx.existingHashes instanceof Set).toBe(true);
  });
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
    // The bank dated this line May 2, so it's May's rent — every statement is read
    // from its own dates (George: "the months … should correspond with the date of
    // the statement"). Jan+Feb are tagged and the $4,000 pool part-covers March, but
    // guessing March for a May check is what recorded his deposits on months he
    // never chose.
    expect(matched[0].month).toBe(5);
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
    expect(imported).toMatchObject({ amount: 9150, period_month: 5 });
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

  // Was: "…clamps an edited-down expense at $0 with a note". 0074 made the roof an
  // itemized list, so undo now DELETES the row it created and re-sums the year from the
  // rows that survive — which is a better answer than subtracting from a figure someone
  // has since moved by hand, and it is what retired the clamp for new imports. The
  // clamp itself lives on for pre-0074 records and is pinned in expenseDatesAndRoof.
  it('undo tolerates a hand-deleted payment, and re-sums the roof from the lines that survive', async () => {
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
    await undoStatementImport(res.import);
    // The import's own line is gone; what's left is the $12,000 that was on the year
    // before the import, carried into its own line by the first itemization. So the
    // year returns to 12,000 — derived from real rows, never negative, and never the
    // 4,000 someone typed over the top of it.
    expect(Number((await getExpenseRecord('prop-2', Y)).roof_total)).toBe(12000);
    const roofLines = await listRoofLineItems('prop-2', Y);
    expect(roofLines.map((r) => r.label)).toEqual(['Entered by hand']);
    for (const r of roofLines) await deleteRoofLineItem(r.id, 'prop-2', Y);
    await upsertExpenseRecord({ property_id: 'prop-2', year: Y, taxes_total: 40000, cam_total: 30000, roof_total: 12000 });
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

// Auto-learned payee rules ride the import as `type:'rule'` entries so a checked tenant
// deposit is remembered automatically and undo reverses exactly what was taught.
describe('statement import — auto-learned payee rules', () => {
  const ruleEntry = (over = {}) => ({ type: 'rule', pattern: 'ZZAUTO PAYEE', property_id: 'prop-1', target_kind: 'tenant', lease_id: 'lease-2', cam_label: null, ...over });

  it('a rule entry creates a rule (prior:null, no hash) and never touches the money counters or dedupe universe', async () => {
    const before = (await listImportRules()).length;
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'learn.csv',
      entries: [paymentEntry(cityDentalCheck, { period_month: 7 }), ruleEntry()],
    });
    expect(res.summary).toMatchObject({ paymentsCount: 1, expensesCount: 0 }); // the rule isn't a money line
    const rec = res.import.applied.find((a) => a.kind === 'rule');
    expect(rec).toMatchObject({ pattern: 'ZZAUTO PAYEE', lease_id: 'lease-2', prior: null });
    expect(rec.hash).toBeUndefined(); // stays out of the duplicate guard
    expect((await listImportRules()).length).toBe(before + 1);
    const ctx = await getStatementMatchContext('prop-1', Y);
    expect([...ctx.existingHashes]).not.toContain(undefined);
    await undoStatementImport(res.import);
  });

  it('undo deletes a brand-new learned rule', async () => {
    const before = (await listImportRules()).length;
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'l2.csv', entries: [ruleEntry({ pattern: 'ZZUNDO PAYEE' })] });
    expect((await listImportRules()).some((r) => r.pattern === 'ZZUNDO PAYEE')).toBe(true);
    await undoStatementImport(res.import);
    expect((await listImportRules()).some((r) => r.pattern === 'ZZUNDO PAYEE')).toBe(false);
    expect((await listImportRules()).length).toBe(before);
  });

  it('a duplicate pattern within one import learns just one rule', async () => {
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'dup.csv', entries: [ruleEntry({ pattern: 'ZZDUP PAYEE' }), ruleEntry({ pattern: 'ZZDUP PAYEE' })] });
    expect(res.import.applied.filter((a) => a.kind === 'rule')).toHaveLength(1);
    expect((await listImportRules()).filter((r) => r.pattern === 'ZZDUP PAYEE')).toHaveLength(1);
    await undoStatementImport(res.import);
  });

  it('overwriting an existing rule records the prior target — undo restores it', async () => {
    await saveImportRule({ property_id: 'prop-1', pattern: 'ZZREASSIGN', target_kind: 'tenant', lease_id: 'lease-2' });
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 're.csv', entries: [ruleEntry({ pattern: 'ZZREASSIGN', lease_id: 'lease-1' })] });
    const rec = res.import.applied.find((a) => a.kind === 'rule');
    expect(rec.prior).toMatchObject({ target_kind: 'tenant', lease_id: 'lease-2' });
    expect((await listImportRules()).find((r) => r.pattern === 'ZZREASSIGN').lease_id).toBe('lease-1'); // overwritten
    await undoStatementImport(res.import);
    expect((await listImportRules()).find((r) => r.pattern === 'ZZREASSIGN').lease_id).toBe('lease-2'); // restored
  });

  it('re-learning the SAME target is a no-op (no applied record, nothing to undo)', async () => {
    await saveImportRule({ property_id: 'prop-1', pattern: 'ZZSAME', target_kind: 'tenant', lease_id: 'lease-2' });
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'same.csv', entries: [ruleEntry({ pattern: 'ZZSAME', lease_id: 'lease-2' })] });
    expect(res.import.applied.filter((a) => a.kind === 'rule')).toHaveLength(0);
    await undoStatementImport(res.import);
  });
});

// The account dimension: a learned rule remembers the statement's masked account hint,
// so the same payee on two accounts resolves right and a rule survives a bank switch.
describe('statement import — account-hinted rule learning', () => {
  const hinted = (over = {}) => ({ type: 'rule', pattern: 'ZZHINT PAYEE', property_id: 'prop-1', target_kind: 'tenant', lease_id: 'lease-2', cam_label: null, ...over });

  it('a learned rule records the statement account hint (create keeps prior:null)', async () => {
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'h1.csv', accountHint: '••4821', entries: [hinted()] });
    const rec = res.import.applied.find((a) => a.kind === 'rule');
    expect(rec.prior).toBe(null);
    expect((await listImportRules()).find((r) => r.pattern === 'ZZHINT PAYEE').account_hint).toBe('••4821');
    await undoStatementImport(res.import);
    expect((await listImportRules()).some((r) => r.pattern === 'ZZHINT PAYEE')).toBe(false);
  });

  it('overwriting from a DIFFERENT account carries the old hint in prior — undo restores target + hint', async () => {
    await saveImportRule({ property_id: 'prop-1', pattern: 'ZZHINT2', target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••1111' });
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'h2.csv', accountHint: '••4821', entries: [hinted({ pattern: 'ZZHINT2', lease_id: 'lease-1' })] });
    const rec = res.import.applied.find((a) => a.kind === 'rule');
    expect(rec.prior).toMatchObject({ target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••1111' });
    const after = (await listImportRules()).find((r) => r.pattern === 'ZZHINT2');
    expect(after.lease_id).toBe('lease-1');
    expect(after.account_hint).toBe('••4821'); // overwritten to the new account
    await undoStatementImport(res.import);
    const restored = (await listImportRules()).find((r) => r.pattern === 'ZZHINT2');
    expect(restored).toMatchObject({ lease_id: 'lease-2', account_hint: '••1111' }); // target + hint restored
    await deleteImportRule(restored.id);
  });

  it('re-learning the SAME target from a new account refreshes the hint with NO applied record', async () => {
    await saveImportRule({ property_id: 'prop-1', pattern: 'ZZHINT3', target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••1111' });
    const res = await applyStatementImport({ propertyId: 'prop-1', year: Y, fileName: 'h3.csv', accountHint: '••4821', entries: [hinted({ pattern: 'ZZHINT3', lease_id: 'lease-2' })] });
    expect(res.import.applied.filter((a) => a.kind === 'rule')).toHaveLength(0); // target unchanged → nothing to undo
    expect((await listImportRules()).find((r) => r.pattern === 'ZZHINT3').account_hint).toBe('••4821'); // but the hint was refreshed
    await undoStatementImport(res.import);
    const still = (await listImportRules()).find((r) => r.pattern === 'ZZHINT3');
    expect(still).toBeTruthy(); // hint-only refresh is intentionally lossy on undo — the rule stays
    await deleteImportRule(still.id);
  });

  // ⚠ THE HOLE THE TIE-OUT FOUND ON PERSHING PLAZA, closed 2026-08-17. Deleting a payment an
  // import created left the bank line still saying "recorded ✓" and still pointing at a row
  // that no longer existed — so real money left the books with no trace anywhere that it had
  // ever arrived, "Money not yet placed" stayed empty because the line counted as decided,
  // and only the tie-out noticed, weeks later. Two D & D Dental deposits of $6,315.00 went
  // that way, and the months were then re-recorded as app-priced `system` rows.
  //
  // The deposit now goes BACK on the work list, keeping its own date and description, where
  // placeUnplacedLine can re-file it with its import provenance intact.
  it('deleting a record an import created puts its bank line back on the work list', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-2', year: Y, fileName: 'release.csv',
      entries: [
        { type: 'payment', lease_id: 'lease-3', property_id: 'prop-2', year: Y, amount: 777, date: `${Y}-05-02`, description: 'ACH FROM NORTHWIND', period_month: 5, reconInvoiceId: null, hash: 'h-rel-1' },
        { type: 'cam', property_id: 'prop-2', year: Y, amount: 321, label: 'Snow removal', date: `${Y}-05-03`, description: 'ACME SNOW', hash: 'h-rel-2' },
      ],
      lines: [
        { hash: 'h-rel-1', date: `${Y}-05-02`, description: 'ACH FROM NORTHWIND', amount: 777, direction: 'in', year: Y, disposition: 'rent' },
        { hash: 'h-rel-2', date: `${Y}-05-03`, description: 'ACME SNOW', amount: 321, direction: 'out', year: Y, disposition: 'expense' },
      ],
    });
    const lineFor = async (hash) => (await listStatementLinesForYear('prop-2', Y)).find((l) => l.line_hash === hash);
    // Both lines start decided and pointing at the row they wrote.
    expect((await lineFor('h-rel-1')).disposition).toBe('rent');
    expect((await lineFor('h-rel-1')).ref_id).toBeTruthy();
    expect((await lineFor('h-rel-2')).ref_kind).toBe('cam');

    const inv = (await listInvoices('lease-3')).find((i) => Number(i.year) === Y && i.status !== 'void');
    const pay = (await listPayments(inv.id)).find((p) => p.import_hash === 'h-rel-1');
    await deletePayment(pay.id);

    const released = await lineFor('h-rel-1');
    expect(released.disposition).toBe('unclassified');
    expect(released.ref_id).toBeNull();
    expect(released.ref_kind).toBeNull();
    // …and it keeps the real date and description, so it can be re-filed rather than retyped.
    expect(released.txn_date).toBe(`${Y}-05-02`);
    expect(released.description).toBe('ACH FROM NORTHWIND');
    // It is on the work list, not merely un-decided in the database.
    expect((await listUnplacedLines('prop-2', Y)).some((l) => l.line_hash === 'h-rel-1')).toBe(true);
    // The OTHER line is untouched — releasing is per-record, never per-import.
    expect((await lineFor('h-rel-2')).disposition).toBe('expense');

    // The same rule on the expense side.
    const camRow = (await listCamLineItems('prop-2', Y)).find((c) => c.import_hash === 'h-rel-2' || c.label === 'Snow removal');
    await deleteCamLineItem(camRow.id, 'prop-2', Y);
    expect((await lineFor('h-rel-2')).disposition).toBe('unclassified');

    await undoStatementImport(res.import);
  });

  it('saveImportRule 23505 path updates the hint in place', async () => {
    const first = await saveImportRule({ property_id: 'prop-1', pattern: 'ZZHINT4', target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••1111' });
    const second = await saveImportRule({ property_id: 'prop-1', pattern: 'zzhint4', target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••4821' });
    expect(second.id).toBe(first.id);
    expect((await listImportRules()).find((r) => r.id === first.id).account_hint).toBe('••4821');
    await deleteImportRule(first.id);
  });
});
