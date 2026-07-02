// Rent-abatement math — replays George's "8 months free rent" scenario through the
// SAME functions the monthly tracker, phase header, and invoice credit use, plus the
// reduced/percent variants. This is the JS mirror of abatement_credit() in migration
// 0041; keeping it green keeps the frontend and the database in agreement.
import {
  monthlyScheduleForYear,
  annualAbatementCredit,
  reducedMonthlyBase,
  activeAbatement,
  abatementEnd,
  abatementCoversMonth,
  abatementMonthCount,
} from '../abatement';
import { buildAbatements } from '../api';

const sum = (obj) => Object.values(obj).reduce((s, c) => s + c.owed, 0);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

describe('abatementEnd + window coverage', () => {
  test('8 months from Jan 1 ends Aug 31 and covers exactly months 1-8', () => {
    const end = abatementEnd('2026-01-01', 8);
    expect(end).toBe('2026-08-31');
    const ab = { start_date: '2026-01-01', end_date: end, kind: 'free' };
    for (let m = 1; m <= 8; m++) expect(abatementCoversMonth(ab, 2026, m)).toBe(true);
    for (let m = 9; m <= 12; m++) expect(abatementCoversMonth(ab, 2026, m)).toBe(false);
    expect(abatementMonthCount(ab)).toBe(8);
  });
});

describe('8-month FREE abatement, base rent only (no CAM/tax)', () => {
  const annualBase = 120000; // $10,000/mo
  const abatements = [{ start_date: '2026-01-01', end_date: abatementEnd('2026-01-01', 8), kind: 'free' }];
  const schedule = monthlyScheduleForYear({ year: 2026, annualBaseRent: annualBase, otherAnnual: 0, abatements });

  test('months 1-8 are free, 9-12 pay full', () => {
    for (let m = 1; m <= 8; m++) {
      expect(schedule[m].owed).toBe(0);
      expect(schedule[m].abated).toBe(true);
    }
    for (let m = 9; m <= 12; m++) {
      expect(schedule[m].owed).toBe(10000);
      expect(schedule[m].abated).toBe(false);
    }
  });

  test('net annual = 4 months of rent; credit = 8 months', () => {
    expect(sum(schedule)).toBe(40000);
    expect(annualAbatementCredit(abatements, 2026, annualBase)).toBe(80000);
  });

  test('reconciles: sum(owed) === gross − credit', () => {
    expect(round2(sum(schedule))).toBe(round2(annualBase - annualAbatementCredit(abatements, 2026, annualBase)));
  });
});

describe('abatement is base-rent only — CAM/taxes still accrue', () => {
  const annualBase = 120000; // $10k/mo base
  const otherAnnual = 24000; // $2k/mo CAM+tax
  const abatements = [{ start_date: '2026-01-01', end_date: abatementEnd('2026-01-01', 8), kind: 'free' }];
  const schedule = monthlyScheduleForYear({ year: 2026, annualBaseRent: annualBase, otherAnnual, abatements });

  test('free months still owe the other charges', () => {
    expect(schedule[1].owed).toBe(2000);  // CAM/tax only
    expect(schedule[9].owed).toBe(12000); // base + CAM/tax
  });

  test('net annual reconciles to gross minus base credit', () => {
    const credit = annualAbatementCredit(abatements, 2026, annualBase);
    expect(round2(sum(schedule))).toBe(round2(annualBase + otherAnnual - credit));
  });
});

describe('reduced (not fully free) abatements', () => {
  const annualBase = 120000; // $10k/mo
  test('50% off base for 6 months', () => {
    const abatements = [{ start_date: '2026-01-01', end_date: abatementEnd('2026-01-01', 6), kind: 'percent', value: 50 }];
    const schedule = monthlyScheduleForYear({ year: 2026, annualBaseRent: annualBase, otherAnnual: 0, abatements });
    expect(schedule[1].owed).toBe(5000);  // half base
    expect(schedule[7].owed).toBe(10000); // full again
    expect(annualAbatementCredit(abatements, 2026, annualBase)).toBe(30000); // 6 × $5k
    expect(reducedMonthlyBase(10000, { kind: 'percent', value: 50 })).toBe(5000);
  });

  test('reduced to a fixed $/mo (amount)', () => {
    const abatements = [{ start_date: '2026-01-01', end_date: abatementEnd('2026-01-01', 6), kind: 'amount', value: 3000 }];
    const schedule = monthlyScheduleForYear({ year: 2026, annualBaseRent: annualBase, otherAnnual: 0, abatements });
    expect(schedule[1].owed).toBe(3000);  // pays the reduced fixed base
    expect(schedule[7].owed).toBe(10000);
    expect(annualAbatementCredit(abatements, 2026, annualBase)).toBe(42000); // 6 × ($10k − $3k)
  });
});

describe('activeAbatement (drives the phase header)', () => {
  const abatements = [{ start_date: '2026-01-01', end_date: '2026-08-31', kind: 'free' }];
  test('inside the window → returns the abatement', () => {
    expect(activeAbatement(abatements, '2026-03-15')).toBeTruthy();
  });
  test('after the window → null', () => {
    expect(activeAbatement(abatements, '2026-10-01')).toBeNull();
  });
});

describe('buildAbatements (extraction/review → insert rows)', () => {
  test('start + months → a dated window; free drops value', () => {
    const rows = buildAbatements([{ start_date: '2026-01-01', months: 8, kind: 'free', value: 50, note: 'build-out' }]);
    expect(rows).toEqual([{ start_date: '2026-01-01', end_date: '2026-08-31', kind: 'free', value: null, note: 'build-out' }]);
  });
  test('percent keeps its value; missing start/end is dropped', () => {
    const rows = buildAbatements([
      { start_date: '2026-01-01', months: 6, kind: 'percent', value: 50 },
      { start_date: null, months: null, kind: 'free' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'percent', value: 50, end_date: '2026-06-30' });
  });
});

describe('multi-year window spills correctly', () => {
  // 8 months free from Oct 1 2026 → Oct 2026..May 2027.
  const abatements = [{ start_date: '2026-10-01', end_date: abatementEnd('2026-10-01', 8), kind: 'free' }];
  const annualBase = 120000;
  test('2026 credits Oct-Dec, 2027 credits Jan-May', () => {
    expect(annualAbatementCredit(abatements, 2026, annualBase)).toBe(30000); // 3 months
    expect(annualAbatementCredit(abatements, 2027, annualBase)).toBe(50000); // 5 months
  });
});
