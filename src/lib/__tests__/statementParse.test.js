// Bank-CSV parsing fixtures — the common export shapes banks actually produce,
// plus the two honesty guarantees: nothing skipped silently, and the running-
// balance self-check that catches a mis-signed line. All pure, $0.
import { describe, it, expect } from 'vitest';
import {
  parseBankStatementCsv, normalizeStatementRows, applyBalanceCheck,
  parseMoney, toIsoDate, accountHintFrom,
} from '../statementParse';

describe('parseMoney / toIsoDate', () => {
  it('handles $, commas, parentheses negatives, and plain minus', () => {
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('(1,234.56)')).toBe(-1234.56);
    expect(parseMoney('-1234.5')).toBe(-1234.5);
    expect(parseMoney('+55')).toBe(55);
    expect(parseMoney('CHECK')).toBe(null);
    expect(parseMoney('')).toBe(null);
  });
  it('US month-first and ISO dates both parse; junk does not', () => {
    expect(toIsoDate('03/05/2026')).toBe('2026-03-05');
    expect(toIsoDate('3/5/26')).toBe('2026-03-05');
    expect(toIsoDate('2026-03-05')).toBe('2026-03-05');
    expect(toIsoDate('13/45/2026')).toBe(null);
    expect(toIsoDate('02/30/2026')).toBe(null); // not a real day
    expect(toIsoDate('yesterday')).toBe(null);
  });
});

describe('parseBankStatementCsv — the common export shapes', () => {
  it('signed single amount column, with $/commas and quoted commas in descriptions', () => {
    const csv = [
      'Date,Description,Amount,Balance',
      '01/05/2026,"CHECK 1044 CITY DENTAL, PC","$8,208.33","$28,208.33"',
      '01/12/2026,COUNTY TREASURER PROP TAX,"($3,100.00)","$25,108.33"',
    ].join('\n');
    const res = parseBankStatementCsv(csv);
    expect(res.transactions).toHaveLength(2);
    expect(res.transactions[0]).toMatchObject({ date: '2026-01-05', description: 'CHECK 1044 CITY DENTAL, PC', amount: 8208.33, direction: 'in' });
    expect(res.transactions[1]).toMatchObject({ date: '2026-01-12', amount: 3100, direction: 'out' });
    expect(res.skippedLines).toHaveLength(0);
    expect(res.warnings).toHaveLength(0); // balance deltas check out
  });

  it('separate Debit/Credit columns', () => {
    const csv = [
      'Posting Date,Description,Debit,Credit',
      '02/01/2026,ACH DEPOSIT BRIGHT COFFEE,,6508.33',
      '02/03/2026,LANDSCAPING SVC INV 88,450.00,',
    ].join('\n');
    const res = parseBankStatementCsv(csv);
    expect(res.transactions[0]).toMatchObject({ direction: 'in', amount: 6508.33 });
    expect(res.transactions[1]).toMatchObject({ direction: 'out', amount: 450 });
  });

  it('junk preamble + BOM survive, and the account hint is captured masked', () => {
    const csv = [
      '﻿First Community Bank',
      'Account: XXXX-XXXX-4821',
      'Statement period 01/01/2026 - 01/31/2026',
      '',
      'Date,Description,Amount',
      '01/05/2026,DEPOSIT,100.00',
    ].join('\n');
    const res = parseBankStatementCsv(csv, { fileName: 'january.csv' });
    expect(res.transactions).toHaveLength(1);
    expect(res.accountHint).toBe('••4821');
  });

  it('falls back to the file name for the account hint', () => {
    expect(accountHintFrom([], 'chase_acct_9944_jan.csv')).toBe('••9944');
    expect(accountHintFrom([], 'statement_0012345678.csv')).toBe('••5678');
    expect(accountHintFrom([], 'january.csv')).toBe(null);
  });

  it('nothing vanishes silently — bad rows land in skippedLines with reasons', () => {
    const csv = [
      'Date,Description,Amount',
      '01/05/2026,GOOD LINE,100.00',
      'not-a-date,BAD DATE,50.00',
      '01/08/2026,NO AMOUNT,',
    ].join('\n');
    const res = parseBankStatementCsv(csv);
    expect(res.transactions).toHaveLength(1);
    expect(res.skippedLines).toHaveLength(2);
    expect(res.skippedLines.map((s) => s.reason)).toEqual(['no valid date', 'no amount']);
  });

  it('balance self-check flags a mis-signed line instead of silently booking it', () => {
    // Line 2's amount is +500 but the balance FELL by 500 — a mis-signed line.
    const csv = [
      'Date,Description,Amount,Balance',
      '01/05/2026,DEPOSIT A,1000.00,2000.00',
      '01/06/2026,MIS-SIGNED,500.00,1500.00',
      '01/07/2026,DEPOSIT B,250.00,1750.00',
    ].join('\n');
    const res = parseBankStatementCsv(csv);
    expect(res.warnings.some((w) => w.includes('Balance check'))).toBe(true);
    expect(res.transactions.filter((t) => t.needsReview)).toHaveLength(1);
    expect(res.transactions.find((t) => t.needsReview).description).toBe('MIS-SIGNED');
  });

  it('a newest-first statement passes the balance check too', () => {
    const csv = [
      'Date,Description,Amount,Balance',
      '01/07/2026,DEPOSIT B,250.00,1750.00',
      '01/06/2026,WITHDRAWAL,(500.00),1500.00',
      '01/05/2026,DEPOSIT A,1000.00,2000.00',
    ].join('\n');
    const res = parseBankStatementCsv(csv);
    expect(res.warnings).toHaveLength(0);
  });
});

describe('normalizeStatementRows — the shared gate both lanes pass', () => {
  it('accepts PDF-lane string amounts/balances and coerces them', () => {
    const { transactions, skippedLines } = normalizeStatementRows([
      { date: '01/05/2026', description: 'CHECK 1044', amount: '8,208.33', direction: 'in', balance: '' },
      { date: '2026-01-06', description: 'TAX', amount: '3100.00', direction: 'out', balance: '25,108.33' },
    ]);
    expect(skippedLines).toHaveLength(0);
    expect(transactions[0]).toMatchObject({ date: '2026-01-05', amount: 8208.33, direction: 'in', balance: null });
    expect(transactions[1]).toMatchObject({ balance: 25108.33 });
  });

  it('structurally-bad model output is skipped with reasons, never matched', () => {
    const { transactions, skippedLines } = normalizeStatementRows([
      { date: 'the fifth of January', description: 'X', amount: '100', direction: 'in' },
      { date: '01/05/2026', description: 'X', amount: 'lots', direction: 'in' },
      { date: '01/05/2026', description: 'X', amount: '100', direction: 'sideways' },
      { date: '01/05/2026', description: 'OK', amount: '100', direction: 'in' },
    ]);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].description).toBe('OK');
    // The reason names the offending value — a landlord reading the skipped list
    // has to be able to tell WHY this line didn't come through.
    expect(skippedLines.map((s) => s.reason)).toEqual([
      'no valid date ("the fifth of January")', 'no amount', 'no direction (in/out)',
    ]);
  });

  // Regression (2026-07-23): George's Chase statement prints every line as a bare
  // "06/01" — the year is stated once, in the period header. toIsoDate required a
  // year, so all 10 lines were skipped "no valid date" and the review screen showed
  // "0 lines parsed · 10 skipped". The demo mock's canned rows all carried tidy
  // full-year dates, so the whole suite passed while the real lane imported nothing.
  it('resolves year-less "MM/DD" lines from the statement period (Chase shape)', () => {
    const chase = [
      { date: '06/01', description: 'Orig CO Name:Five Points Wing Orig ID:9200502235', amount: '5,324.00', direction: 'in', balance: '' },
      { date: '06/01', description: 'Online ACH Debit 9031473238 From Samsnails', amount: '4,418.00', direction: 'in', balance: '' },
      { date: '06/10', description: 'Orig CO Name:Vanguard Buy Orig ID:Vmc Pur', amount: '65,000.00', direction: 'out', balance: '' },
      { date: '06/30', description: 'Online ACH Debit 9031881141 From Hiarcut', amount: '3,750.00', direction: 'in', balance: '' },
    ];
    const { transactions, skippedLines } = normalizeStatementRows(chase, {
      periodStart: '05/30/2026', periodEnd: '06/30/2026',
    });
    expect(skippedLines).toHaveLength(0);
    expect(transactions.map((t) => t.date)).toEqual(['2026-06-01', '2026-06-01', '2026-06-10', '2026-06-30']);
    expect(transactions[0].amount).toBe(5324);
    expect(transactions[2].direction).toBe('out');
  });

  it('a statement straddling New Year puts each month/day in its own year', () => {
    const { transactions } = normalizeStatementRows([
      { date: '12/28', description: 'DEC RENT', amount: '1000', direction: 'in' },
      { date: '01/03', description: 'JAN RENT', amount: '1000', direction: 'in' },
    ], { periodStart: '12/15/2025', periodEnd: '01/14/2026' });
    expect(transactions.map((t) => t.date)).toEqual(['2025-12-28', '2026-01-03']);
  });

  it('falls back to the year the fully-dated lines agree on when no period was read', () => {
    const { transactions, skippedLines } = normalizeStatementRows([
      { date: '06/02/2026', description: 'A', amount: '100', direction: 'in' },
      { date: '06/03', description: 'B', amount: '200', direction: 'in' },
    ]);
    expect(skippedLines).toHaveLength(0);
    expect(transactions[1].date).toBe('2026-06-03');
  });

  it('with no year context at all the line is skipped, saying exactly why', () => {
    const { transactions, skippedLines } = normalizeStatementRows([
      { date: '06/01', description: 'A', amount: '100', direction: 'in' },
    ]);
    expect(transactions).toHaveLength(0);
    expect(skippedLines[0].reason).toBe('the date "06/01" has no year, and the statement period wasn\'t captured');
    // The skipped row reads as the statement line it came from, not a JSON blob.
    expect(skippedLines[0].raw).toBe('06/01 · A · 100');
  });

  it('a bare "MM/DD" still never parses without context — CSV column inference relies on it', () => {
    expect(toIsoDate('06/01')).toBe(null);
    expect(toIsoDate('06/01', { fallbackYear: 2026 })).toBe('2026-06-01');
    expect(toIsoDate('13/45', { fallbackYear: 2026 })).toBe(null);
  });

  it('applyBalanceCheck also runs on normalized PDF rows', () => {
    const { transactions } = normalizeStatementRows([
      { date: '2026-01-05', description: 'A', amount: '1000', direction: 'in', balance: '2000' },
      { date: '2026-01-06', description: 'B', amount: '500', direction: 'in', balance: '1500' },
    ]);
    const checked = applyBalanceCheck(transactions);
    expect(checked.warnings.length).toBe(1);
  });
});
