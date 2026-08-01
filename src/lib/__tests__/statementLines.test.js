// Slice 4a — every line accounted for.
//
// George's rule: a dollar that crossed the bank is either recorded somewhere or
// explicitly left out with a reason. Never dropped. Before 0076, a line nothing
// recognized arrived unticked and saving produced no write AND no record that the
// line had ever existed — statement_imports.applied stores what an import wrote and
// nothing about what it passed over, so "did I ever book that Comcast bill?" had no
// answer inside the app.
//
// These tests pin the guarantee itself: the row count equals the line count, and no
// line is ever in an unknown state.
import { describe, it, expect } from 'vitest';
import {
  DISPOSITIONS, dispositionInfo, isPlaced, lineCompleteness, completenessSentence,
  dispositionForRow, IGNORE_REASONS, ignoreReasonLabel,
} from '../dispositions';
import { applyStatementImport, undoStatementImport, listStatementLines, listUnplacedLines, setLineDisposition } from '../api';
import { supabase } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();

describe('the disposition vocabulary', () => {
  it('has exactly one unplaced state, and it is unclassified', () => {
    const unplaced = DISPOSITIONS.filter((d) => !d.placed);
    expect(unplaced.map((d) => d.key)).toEqual(['unclassified']);
    // Being deliberately left out IS being accounted for — that is the whole point of
    // giving Ignore a reason rather than treating it as a hole.
    expect(isPlaced('ignored')).toBe(true);
    expect(isPlaced('rent')).toBe(true);
    expect(isPlaced('expense')).toBe(true);
  });

  // A row written by a later round read by an older bundle must never read as placed:
  // guessing "placed" hides money, and this whole slice exists because hidden money is
  // the failure mode. 'debt' and 'capital' are Slice 5/6 and genuinely do not exist
  // yet — 'owner' was the example here until round 7 made it real, which is exactly
  // the scenario this guard is for.
  it('treats an unknown disposition as unplaced, never as placed', () => {
    expect(isPlaced('debt')).toBe(false);
    expect(isPlaced(undefined)).toBe(false);
    expect(dispositionInfo('capital').short).toBe('Unplaced');
  });

  // Slice 4b — the three homes round 7 added. All PLACED: a draw recorded is
  // accounted for even though it appears in no expense total, and a transfer is real
  // money movement that is neither income nor expense. "Accounted for" means somebody
  // decided, NOT "counted as a cost".
  it('counts an owner draw, an entity cost and a transfer as accounted for', () => {
    expect(isPlaced('owner')).toBe(true);
    expect(isPlaced('entity')).toBe(true);
    expect(isPlaced('transfer')).toBe(true);
    // Still exactly one unplaced state, however many homes exist.
    expect(DISPOSITIONS.filter((d) => !d.placed).map((d) => d.key)).toEqual(['unclassified']);
  });

  it('names every ignore reason it offers', () => {
    for (const r of IGNORE_REASONS) expect(ignoreReasonLabel(r.key)).toBe(r.label);
    expect(ignoreReasonLabel('nonsense')).toBeNull();
  });
});

describe('what a review row resolves to', () => {
  it('records a ticked deposit as rent and a ticked expense as an expense', () => {
    expect(dispositionForRow({ checked: true, kind: 'tenant' })).toBe('rent');
    expect(dispositionForRow({ checked: true, kind: 'expense_cam' })).toBe('expense');
    expect(dispositionForRow({ checked: true, kind: 'expense_tax' })).toBe('expense');
    expect(dispositionForRow({ checked: true, kind: 'expense_roof' })).toBe('expense');
    expect(dispositionForRow({ checked: true, kind: 'expense_other' })).toBe('expense');
  });

  it('records an ignore the landlord PICKED as a decision', () => {
    expect(dispositionForRow({ checked: false, kind: 'ignore', picked: true })).toBe('ignored');
  });

  // THE judgement of this round. The matcher bins MORTGAGE / LOAN / TRANSFER / DRAW by
  // keyword and hands the row over as kind:'ignore' with nobody having chosen anything.
  // Recording that as a decision would credit the landlord with a choice they never
  // made — and those lines are exactly the ones with no home in Amlak YET (rounds 7
  // and 8 give them one), so they must keep nagging until they do.
  it('does NOT treat the matcher\'s own keyword ignore as a decision', () => {
    expect(dispositionForRow({ checked: false, kind: 'ignore', picked: false })).toBe('unclassified');
  });

  // Unticking is not excluding. A row can arrive unticked because it needs review, and
  // "I'll deal with it later" must not be recorded as "leave it out forever".
  it('leaves an unticked-but-matched line unplaced rather than calling it ignored', () => {
    expect(dispositionForRow({ checked: false, kind: 'tenant', picked: false })).toBe('unclassified');
    expect(dispositionForRow({ checked: false, kind: 'expense_cam', picked: false })).toBe('unclassified');
  });

  // A duplicate is the one exclusion nobody has to decide: the guard already matched it
  // to money recorded by an earlier import. Nagging about it would train the landlord
  // to ignore the nag.
  it('counts a duplicate as accounted for without asking', () => {
    expect(dispositionForRow({ checked: false, kind: 'tenant', picked: false, duplicate: true })).toBe('ignored');
  });
});

describe('the completeness tie-out', () => {
  const line = (disposition, amount, direction) => ({ disposition, amount, direction });

  it('counts every line, placed or not', () => {
    const c = lineCompleteness([
      line('rent', 5000, 'in'), line('expense', 800, 'out'),
      line('ignored', 20154.11, 'in'), line('unclassified', 4281, 'out'),
    ]);
    expect(c.total).toBe(4);
    expect(c.placed).toBe(3);
    expect(c.unplaced).toBe(1);
    expect(c.ignored).toBe(1);
    expect(c.byDisposition).toEqual({ rent: 1, expense: 1, ignored: 1, unclassified: 1 });
  });

  // The refusal that decides the shape of the figure: an unplaced $5,000 deposit and
  // an unplaced $5,000 withdrawal must NEVER net to "$0 unplaced". A single netted
  // number would report perfect health on a statement where $10,000 is unaccounted
  // for — the exact silent loss this slice exists to end.
  it('keeps unplaced money in and out apart so they cannot cancel out', () => {
    const c = lineCompleteness([line('unclassified', 5000, 'in'), line('unclassified', 5000, 'out')]);
    expect(c.unplaced).toBe(2);
    expect(c.unplacedIn).toBe(5000);
    expect(c.unplacedOut).toBe(5000);
    expect(c).not.toHaveProperty('unplacedNet');
  });

  it('reads the amount as a magnitude however the sign arrives', () => {
    const c = lineCompleteness([line('unclassified', -1200, 'out')]);
    expect(c.unplacedOut).toBe(1200);
  });

  it('states completeness plainly, and says nothing at all with no lines', () => {
    expect(completenessSentence(lineCompleteness([line('rent', 1, 'in'), line('ignored', 2, 'out')])))
      .toBe('2 of 2 lines placed ✓');
    expect(completenessSentence(lineCompleteness([]))).toBe('');
    const s = completenessSentence(lineCompleteness([line('rent', 1, 'in'), line('unclassified', 4281, 'out')]));
    expect(s).toBe('1 of 2 lines placed · 1 not placed ($4,281.00 out)');
  });
});

// ── Against the demo mock: the whole round-trip ───────────────────────────────────
// The guarantee is only real if it survives the actual import path, so these drive
// applyStatementImport / undoStatementImport rather than the pure helpers.

const PROP = 'prop-1';

const mkLines = () => ([
  { hash: 'h-rent', year: Y, date: `${Y}-03-05`, description: 'ACH CITY DENTAL', amount: 9150, direction: 'in', disposition: 'rent' },
  { hash: 'h-cam', year: Y, date: `${Y}-03-09`, description: 'GREENLEAF LANDSCAPING', amount: 800, direction: 'out', disposition: 'expense' },
  { hash: 'h-draw', year: Y, date: `${Y}-03-12`, description: 'ONLINE TRANSFER TO CHECKING 8966', amount: 20154.11, direction: 'out', disposition: 'unclassified' },
  { hash: 'h-skip', year: Y, date: `${Y}-03-15`, description: 'VANGUARD BUY', amount: 65000, direction: 'out', disposition: 'ignored', ignore_reason: 'personal' },
]);

const mkEntries = () => ([
  { type: 'payment', lease_id: 'lease-2', property_id: PROP, year: Y, amount: 9150, date: `${Y}-03-05`, description: 'ACH CITY DENTAL', period_month: 3, hash: 'h-rent' },
  { type: 'cam', property_id: PROP, year: Y, amount: 800, date: `${Y}-03-09`, label: 'Landscaping', billable: true, hash: 'h-cam' },
]);

describe('the import records every line it read', () => {
  it('writes one row per transcribed line — including the ones that wrote nothing', async () => {
    const res = await applyStatementImport({
      propertyId: PROP, year: Y, fileName: 'march.pdf', entries: mkEntries(), lines: mkLines(),
    });
    const stored = await listStatementLines(res.import.id);
    // The guarantee, stated as an assertion: the row count IS the line count.
    expect(stored.length).toBe(4);
    expect(res.summary.completeness.total).toBe(4);
    expect(res.summary.completeness.placed).toBe(3);
    expect(res.summary.completeness.unplacedOut).toBe(20154.11);

    const byHash = Object.fromEntries(stored.map((l) => [l.line_hash, l]));
    // The line nobody recognized is PRESENT and honest about it — this is the row that
    // simply did not exist before, and its absence is what "the money disappeared"
    // actually meant.
    expect(byHash['h-draw'].disposition).toBe('unclassified');
    expect(byHash['h-draw'].description).toContain('TRANSFER');
    expect(Number(byHash['h-draw'].amount)).toBe(20154.11);
    // A deliberate exclusion keeps its reason…
    expect(byHash['h-skip'].disposition).toBe('ignored');
    expect(byHash['h-skip'].ignore_reason).toBe('personal');
    // …and a line that wrote money names what it produced.
    expect(byHash['h-rent'].ref_kind).toBe('payment');
    expect(byHash['h-rent'].ref_id).toBeTruthy();
    expect(byHash['h-cam'].ref_kind).toBe('cam');

    await undoStatementImport(res.import);
  });

  it('surfaces the unplaced line on the property, and lets it be settled with a reason', async () => {
    const res = await applyStatementImport({
      propertyId: PROP, year: Y, fileName: 'march.pdf', entries: mkEntries(), lines: mkLines(),
    });
    const open = await listUnplacedLines(PROP, Y);
    expect(open.map((l) => l.line_hash)).toEqual(['h-draw']);

    // Answering the nag records the decision — it does not delete the line, because
    // the audit record has to survive the answer.
    await setLineDisposition(open[0].id, 'ignored', 'transfer');
    expect(await listUnplacedLines(PROP, Y)).toHaveLength(0);
    const after = await listStatementLines(res.import.id);
    expect(after).toHaveLength(4);
    expect(after.find((l) => l.line_hash === 'h-draw').ignore_reason).toBe('transfer');

    await undoStatementImport(res.import);
  });

  // 0076 declares ON DELETE CASCADE, but undoStatementImport deletes explicitly — the
  // demo mock has no foreign keys, so a cascade-only design would pass this suite and
  // leave orphans live. Pinned here so nobody "tidies up" the explicit delete.
  it('takes its lines away when the import is undone', async () => {
    const res = await applyStatementImport({
      propertyId: PROP, year: Y, fileName: 'march.pdf', entries: mkEntries(), lines: mkLines(),
    });
    expect(await listStatementLines(res.import.id)).toHaveLength(4);
    await undoStatementImport(res.import);
    expect(await listStatementLines(res.import.id)).toHaveLength(0);
    expect(await listUnplacedLines(PROP, Y)).toHaveLength(0);
  });

  // Two byte-identical lines on one statement share a hash. Both get their OWN audit
  // row, and each points at its own payment rather than both naming the first.
  it('gives two identical lines their own rows and their own refs', async () => {
    const twin = { hash: 'h-twin', year: Y, date: `${Y}-03-20`, description: 'CHECK 1044', amount: 500, direction: 'in', disposition: 'rent' };
    const entry = { type: 'payment', lease_id: 'lease-2', property_id: PROP, year: Y, amount: 500, date: `${Y}-03-20`, description: 'CHECK 1044', period_month: null, hash: 'h-twin' };
    const res = await applyStatementImport({
      propertyId: PROP, year: Y, fileName: 'twins.pdf', entries: [entry, { ...entry }], lines: [twin, { ...twin }],
    });
    const stored = await listStatementLines(res.import.id);
    expect(stored).toHaveLength(2);
    const refs = stored.map((l) => l.ref_id);
    expect(refs.every(Boolean)).toBe(true);
    expect(new Set(refs).size).toBe(2);
    await undoStatementImport(res.import);
  });

  // An import from before 0076 (and any caller that passes no lines) must still work
  // exactly as it did — the audit table is additive, not a new requirement.
  it('imports fine with no lines at all, and claims no completeness it cannot back', async () => {
    const res = await applyStatementImport({
      propertyId: PROP, year: Y, fileName: 'legacy.pdf', entries: mkEntries(),
    });
    expect(res.summary.paymentsCount).toBe(1);
    expect(res.summary.completeness.total).toBe(0);
    expect(await listStatementLines(res.import.id)).toHaveLength(0);
    await undoStatementImport(res.import);
  });

  // The audit table must never be able to cost someone an import. Money first.
  it('keeps an import whose audit write fails', async () => {
    const realFrom = supabase.from.bind(supabase);
    supabase.from = (table) => (table === 'statement_lines'
      ? { insert: () => { throw new Error('audit table unavailable'); }, delete: () => ({ eq: async () => [] }) }
      : realFrom(table));
    try {
      const res = await applyStatementImport({
        propertyId: PROP, year: Y, fileName: 'march.pdf', entries: mkEntries(), lines: mkLines(),
      });
      expect(res.summary.paymentsCount).toBe(1);
      expect(res.summary.expensesCount).toBe(1);
      supabase.from = realFrom;
      await undoStatementImport(res.import);
    } finally {
      supabase.from = realFrom;
    }
  });
});
