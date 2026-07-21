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
    expect(skippedLines.map((s) => s.reason)).toEqual(['no valid date', 'no amount', 'no direction (in/out)']);
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
