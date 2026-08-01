// Slice 4b — money that crossed the bank and belongs to the entity or its owner.
//
// The one thing every test here is really guarding: **a draw is not an expense.** It
// must never reach expense_records, never move cam_total, never move a tenant's share
// and never appear in NOI. Two of them are already sitting in George's live data as
// not-billed expense lines ("Liana", "Yazin"), which is what makes that the headline
// rather than a nicety.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ENTITY_KINDS, entityKindInfo, isEntityKind, entityKindsFor,
  summarizeEntityLedger, absorbedFromItems, whatStayed,
} from '../entityLedger';
import {
  applyStatementImport, undoStatementImport, listEntityLedger, listEntityLedgerByCorps,
  addEntityLedgerEntry, deleteEntityLedgerEntry, placeUnplacedLine,
  listUnplacedLines, listCamLineItems, getExpenseRecord, getTenantShares, getPropertyTotals,
} from '../api';
import { currentYear } from '../format';

const Y = currentYear();

describe('the entity vocabulary', () => {
  it('separates equity from expense, and says which is which', () => {
    expect(ENTITY_KINDS.map((k) => k.key)).toEqual(['draw', 'contribution', 'cost']);
    // The whole point: only an entity COST is an expense. A draw and a contribution
    // move equity and belong on no profit-and-loss statement.
    expect(entityKindInfo('draw').isExpense).toBe(false);
    expect(entityKindInfo('contribution').isExpense).toBe(false);
    expect(entityKindInfo('cost').isExpense).toBe(true);
    // Direction decides which dropdown offers it.
    expect(entityKindsFor('out').map((k) => k.key)).toEqual(['draw', 'cost']);
    expect(entityKindsFor('in').map((k) => k.key)).toEqual(['contribution']);
  });

  // Same refusal the disposition registry makes: a kind written by a later round and
  // read by an older bundle must not be silently folded into a known total.
  it('reports an unknown kind rather than guessing one', () => {
    expect(isEntityKind('debt')).toBe(false);
    expect(entityKindInfo('debt').sign).toBe(0);
    const s = summarizeEntityLedger([{ kind: 'debt', amount: 900 }]);
    expect(s.unknown).toBe(900);
    expect(s.draws + s.contributions + s.costs).toBe(0);
  });

  it('totals each kind on its own, from absolute amounts', () => {
    const s = summarizeEntityLedger([
      { kind: 'draw', amount: 24000 },
      { kind: 'draw', amount: -1000 },   // a sign slip must not cancel a real draw
      { kind: 'cost', amount: 1750 },
      { kind: 'contribution', amount: 5000 },
    ]);
    expect(s).toMatchObject({ draws: 25000, costs: 1750, contributions: 5000, count: 4 });
  });
});

describe('costs the landlord absorbed', () => {
  it('counts only the lines marked not-billed', () => {
    const items = [
      { amount: 12000, billable: true },
      { amount: 6000, billable: false },
      { amount: 843, billable: false },
      { amount: 500 },                    // undefined = billable, the column's default
    ];
    expect(absorbedFromItems(items)).toEqual({ total: 6843, count: 2 });
  });
});

describe('what actually stayed', () => {
  it('reads as a subtraction that adds up to its own total', () => {
    const { lines, stayed } = whatStayed({ noi: 150837, absorbed: 6420, draws: 84000, entityCosts: 2400 });
    expect(stayed).toBe(150837 - 6420 - 84000 - 2400);
    // Summed from the rows SHOWN — a strip whose figures don't add up to its own
    // answer is worse than no strip.
    const fromRows = lines.reduce((n, l) => n + l.sign * l.amount, 0);
    expect(Math.round(fromRows * 100) / 100).toBe(stayed);
  });

  it('omits every zero line but never NOI, and stays silent when there is nothing to reconcile', () => {
    const only = whatStayed({ noi: 150837 });
    expect(only.lines.map((l) => l.key)).toEqual(['noi']);
    expect(only.stayed).toBe(150837);
    const some = whatStayed({ noi: 100, draws: 40 });
    expect(some.lines.map((l) => l.key)).toEqual(['noi', 'draws']);
  });

  it('adds a contribution and subtracts a draw', () => {
    expect(whatStayed({ noi: 0, contributions: 5000 }).stayed).toBe(5000);
    expect(whatStayed({ noi: 0, draws: 5000 }).stayed).toBe(-5000);
  });
});

// ---- against the demo mock: the real write path ------------------------------
describe('a draw recorded through an import', () => {
  let before;
  beforeEach(async () => {
    before = {
      cam: await getExpenseRecord('prop-1', Y),
      shares: await getTenantShares('prop-1', Y),
      totals: await getPropertyTotals('prop-1', Y),
    };
  });

  it('lands in the entity ledger and NOWHERE near a tenant’s bill', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'draw.csv',
      entries: [{
        type: 'entity', kind: 'draw', corporation_id: 'corp-1', property_id: 'prop-1',
        year: Y, amount: 24000, date: `${Y}-03-15`, label: 'Owner distribution', hash: 'h-draw',
      }],
      lines: [{ hash: 'h-draw', year: Y, date: `${Y}-03-15`, description: 'ONLINE DRAW 04', amount: 24000, direction: 'out', disposition: 'owner' }],
    });

    // It is recorded…
    const led = await listEntityLedger({ propertyId: 'prop-1', year: Y });
    expect(led.find((e) => e.line_hash === 'h-draw')).toMatchObject({ kind: 'draw', amount: 24000 });

    // …and it is NOT an expense, on every surface that could have been fooled.
    const cam = await getExpenseRecord('prop-1', Y);
    expect(cam.cam_total).toBe(before.cam.cam_total);
    expect(cam.taxes_total).toBe(before.cam.taxes_total);
    expect(cam.roof_total).toBe(before.cam.roof_total);
    const items = await listCamLineItems('prop-1', Y);
    expect(items.some((i) => Math.abs(Number(i.amount)) === 24000)).toBe(false);
    // Not one tenant's share moved by a penny.
    const shares = await getTenantShares('prop-1', Y);
    expect(shares.map((s) => [s.tenant_name, s.cam_amount, s.tax_amount, s.total_due]))
      .toEqual(before.shares.map((s) => [s.tenant_name, s.cam_amount, s.tax_amount, s.total_due]));
    const totals = await getPropertyTotals('prop-1', Y);
    expect(totals.noi).toBe(before.totals.noi);

    // The import summary counts it apart from expenses, because it IS apart.
    expect(res.summary.expensesCount).toBe(0);
    expect(res.summary.entityOutCount).toBe(1);
    expect(res.summary.entityOutTotal).toBe(24000);

    // Undo reverses it exactly.
    await undoStatementImport(res.import);
    const after = await listEntityLedger({ propertyId: 'prop-1', year: Y });
    expect(after.some((e) => e.line_hash === 'h-draw')).toBe(false);
  });

  it('an entity cost is an expense of the LLC — and still not of the building', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'ent.csv',
      entries: [{ type: 'entity', kind: 'cost', corporation_id: 'corp-1', property_id: 'prop-1', year: Y, amount: 1750, date: `${Y}-02-01`, label: 'Franchise tax', hash: 'h-ent' }],
      lines: [{ hash: 'h-ent', year: Y, date: `${Y}-02-01`, description: 'IL SOS FRANCHISE TAX', amount: 1750, direction: 'out', disposition: 'entity' }],
    });
    expect((await getExpenseRecord('prop-1', Y)).cam_total).toBe(before.cam.cam_total);
    // No category on arrival, on purpose — 0075's rule. A defaulted 'Other' would
    // hide exactly the decision that wants surfacing.
    const row = (await listEntityLedger({ propertyId: 'prop-1', year: Y })).find((e) => e.line_hash === 'h-ent');
    expect(row.category).toBeNull();
    await undoStatementImport(res.import);
  });
});

describe('placing a line from the Ledger panel', () => {
  it('gives an unplaced line a home without re-importing, and links what it produced', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'unplaced.csv', entries: [],
      lines: [{ hash: 'h-x', year: Y, date: `${Y}-04-02`, description: 'ONLINE DRAW APRIL', amount: 9000, direction: 'out', disposition: 'unclassified' }],
    });
    const [line] = await listUnplacedLines('prop-1', Y);
    expect(line.description).toContain('DRAW');

    const { entry } = await placeUnplacedLine(line, { kind: 'draw', corporationId: 'corp-1' });
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(0);
    expect(entry.amount).toBe(9000);
    // The audit row names what it produced, so a line placed AFTER the import is as
    // traceable as one placed during it.
    const lines = await listUnplacedLines('prop-1', Y);
    expect(lines).toHaveLength(0);
    const led = await listEntityLedger({ propertyId: 'prop-1', year: Y });
    expect(led.find((e) => e.id === entry.id)).toBeTruthy();
    await deleteEntityLedgerEntry(entry.id);
    await undoStatementImport(res.import);
  });

  it('records a transfer with no ledger row at all — the disposition IS the record', async () => {
    const res = await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'xfer.csv', entries: [],
      lines: [{ hash: 'h-t', year: Y, date: `${Y}-04-03`, description: 'MOBILE BANKING TRANSFER FROM 8966', amount: 20154.11, direction: 'in', disposition: 'unclassified' }],
    });
    const [line] = await listUnplacedLines('prop-1', Y);
    const beforeRows = (await listEntityLedger({ propertyId: 'prop-1', year: Y })).length;

    const out = await placeUnplacedLine(line, { kind: 'transfer', corporationId: 'corp-1' });
    expect(out.entry).toBeNull();
    expect((await listEntityLedger({ propertyId: 'prop-1', year: Y })).length).toBe(beforeRows);
    expect(await listUnplacedLines('prop-1', Y)).toHaveLength(0);
    await undoStatementImport(res.import);
  });
});

describe('the corporation roll-up', () => {
  it('groups by corporation and keeps the seeded demo money visible', async () => {
    const byCorp = await listEntityLedgerByCorps(Y);
    const sum = summarizeEntityLedger(byCorp['corp-1'] || []);
    expect(sum.draws).toBeGreaterThan(0);
    expect(sum.costs).toBeGreaterThan(0);
    expect(sum.contributions).toBeGreaterThan(0);
  });

  it('a hand-recorded entry with no property still belongs to its corporation', async () => {
    const row = await addEntityLedgerEntry({ corporation_id: 'corp-1', property_id: null, year: Y, kind: 'cost', amount: 400, label: 'Registered agent' });
    const byProp = await listEntityLedger({ propertyId: 'prop-1', year: Y });
    expect(byProp.some((e) => e.id === row.id)).toBe(false);
    const byCorp = await listEntityLedger({ corporationId: 'corp-1', year: Y });
    expect(byCorp.some((e) => e.id === row.id)).toBe(true);
    await deleteEntityLedgerEntry(row.id);
  });
});
