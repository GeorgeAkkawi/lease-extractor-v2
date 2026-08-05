// The pure contract diff (src/lib/contractTerms.js) — what a newly-read contract document
// would change, and what it deliberately refuses to change.
import { describe, it, expect } from 'vitest';
import {
  FIELDS, contractChanges, contractTargets, buildContractFeeSteps,
  buildContractConfidence, hasNoContractChanges, noticeDueDate,
} from '../contractTerms';

const f = (value, confidence = 0.9) => ({ value, confidence, source_quote: '', page: 1 });

const CONTRACT = {
  id: 'c1', property_id: 'p1', name: 'Snow removal — Arctic',
  service_type: 'snow_removal', vendor: 'Arctic Snow Services', vendor_email: null,
  amount: 7000, frequency: 'annual', escalation_pct: null,
  start_date: '2024-11-01', end_date: '2026-10-31',
  auto_renew: null, notice_days: null, notice_by_date: null, renewal_term_months: null,
};

describe('FIELDS', () => {
  // A contract's name is the CAM line item's LABEL, the alert's TITLE and the reminder
  // email's SUBJECT. A document printing the trading name slightly differently would
  // silently relabel a Financials line and retitle a live alert.
  it('never carries `name` — renaming stays a deliberate act', () => {
    expect(FIELDS.some((x) => x.key === 'name')).toBe(false);
  });

  // Exactly the fields that change contractAnnualCost or contractCoversYear — the only
  // route from this document to a CAM row, a tenant's share and a stored invoice.
  it('marks precisely the billed fields', () => {
    expect(FIELDS.filter((x) => x.billed).map((x) => x.key).sort())
      .toEqual(['amount', 'end_date', 'escalation_pct', 'frequency', 'start_date']);
  });
});

describe('contractChanges', () => {
  it('reports only what the document actually states', () => {
    const ch = contractChanges({
      contract: CONTRACT,
      extraction: { amount: f(8000), vendor: f('Arctic Snow Services') },
    });
    expect(ch.fields.map((x) => x.key)).toEqual(['amount']);
    expect(ch.fields[0].from).toBe(7000);
    expect(ch.fields[0].to).toBe(8000);
    expect(ch.touchesBilling).toBe(true);
  });

  // Silence in a document is not an instruction to erase. A contract the AI couldn't read a
  // vendor email out of must not blank the one already on file.
  it('a field the document is silent on is left alone', () => {
    const withEmail = { ...CONTRACT, vendor_email: 'billing@arctic.example' };
    const ch = contractChanges({ contract: withEmail, extraction: { amount: f(8000) } });
    expect(ch.fields.some((x) => x.key === 'vendor_email')).toBe(false);
  });

  it('reads a bare value as well as the wrapped shape', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { amount: 8000 } });
    expect(ch.fields.map((x) => x.key)).toEqual(['amount']);
  });

  it('maps cancellation_notice_days onto notice_days', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { cancellation_notice_days: f(30) } });
    const hit = ch.fields.find((x) => x.key === 'notice_days');
    expect(hit.to).toBe(30);
  });

  it('a change that touches no billed field says so', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { vendor_email: f('ar@arctic.example') } });
    expect(ch.fields.map((x) => x.key)).toEqual(['vendor_email']);
    expect(ch.touchesBilling).toBe(false);
  });

  // "2033-04-31" parses in V8 (it rolls to May 1) and fails in Postgres, which would kill
  // the ENTIRE apply. There are no fields in the review dialog to correct it in.
  it('drops a date that isn’t a real day and names what was printed', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { end_date: f('2033-04-31') } });
    expect(ch.fields.some((x) => x.key === 'end_date')).toBe(false);
    expect(ch.unusableDates).toEqual([{ key: 'end_date', label: 'End', printed: '2033-04-31' }]);
  });

  describe('the derived notice date', () => {
    it('is computed from end_date − notice_days and flagged as derived', () => {
      const ch = contractChanges({
        contract: CONTRACT,
        extraction: { cancellation_notice_days: f(30) },
      });
      const hit = ch.fields.find((x) => x.key === 'notice_by_date');
      expect(hit.to).toBe('2026-10-01'); // 30 days before the 2026-10-31 term end
      expect(ch.noticeDerived).toMatchObject({ value: '2026-10-01', days: 30, from: '2026-10-31' });
    });

    it('a date the document PRINTS beats the arithmetic', () => {
      const ch = contractChanges({
        contract: CONTRACT,
        extraction: { cancellation_notice_days: f(30), notice_by_date: f('2026-09-15') },
      });
      expect(ch.fields.find((x) => x.key === 'notice_by_date').to).toBe('2026-09-15');
      expect(ch.noticeDerived).toBe(null);
    });

    // Deriving the same date already stored is not news — reporting it would make
    // hasNoContractChanges answer "there are changes" for a document that says nothing new.
    it('is not reported when it derives what is already on the contract', () => {
      const already = { ...CONTRACT, notice_days: 30, notice_by_date: '2026-10-01' };
      const ch = contractChanges({ contract: already, extraction: { cancellation_notice_days: f(30) } });
      expect(ch.noticeDerived).toBe(null);
      expect(hasNoContractChanges(ch)).toBe(true);
    });
  });
});

describe('buildContractFeeSteps — the model reads, the code multiplies', () => {
  const targets = { frequency: 'annual', startDate: '2024-11-01' };

  it('annualizes per_month ×12 and leaves per_year alone', () => {
    const { steps } = buildContractFeeSteps({
      fee_schedule: [
        { effective_date: '2024-11-01', amount: 500, period: 'per_month', quote: 'a' },
        { effective_date: '2025-11-01', amount: 7000, period: 'per_year', quote: 'b' },
      ],
    }, targets);
    expect(steps.map((s) => s.new_amount)).toEqual([6000, 7000]);
  });

  // A snow contract's "per season" fee IS its yearly cost — exactly how the pre-0091
  // escalation scalar treated it.
  it('treats per_season as a yearly figure', () => {
    const { steps } = buildContractFeeSteps({
      fee_schedule: [{ effective_date: '2024-11-01', amount: 7000, period: 'per_season', quote: '' }],
    }, targets);
    expect(steps[0].new_amount).toBe(7000);
  });

  it('converts into a MONTHLY contract’s own frequency', () => {
    const { steps } = buildContractFeeSteps({
      fee_schedule: [{ effective_date: '2025-01-01', amount: 18000, period: 'per_year', quote: '' }],
    }, { frequency: 'monthly', startDate: '2024-01-01' });
    expect(steps[0].new_amount).toBe(1500);
  });

  it('anchors a months_from_start row to the start date', () => {
    const { steps, undated } = buildContractFeeSteps({
      fee_schedule: [
        { effective_date: null, months_from_start: 0, amount: 7000, period: 'per_year', quote: '' },
        { effective_date: null, months_from_start: 12, amount: 7500, period: 'per_year', quote: '' },
      ],
    }, targets);
    expect(steps.map((s) => s.effective_date)).toEqual(['2024-11-01', '2025-11-01']);
    expect(undated).toBe(0);
  });

  // An offset with no start date to anchor it is not a date. Inventing one off today would
  // land the whole schedule in the wrong years.
  it('reports an offset it cannot anchor rather than guessing', () => {
    const { steps, undated } = buildContractFeeSteps({
      fee_schedule: [{ effective_date: null, months_from_start: 12, amount: 7500, period: 'per_year', quote: '' }],
    }, { frequency: 'annual', startDate: null });
    expect(steps).toHaveLength(0);
    expect(undated).toBe(1);
  });

  // A per-visit rate needs a visit count the document does not state. Guessing one is how a
  // $250 call-out becomes a year of CAM.
  it('refuses a per_visit or unknown basis and counts it as unusable', () => {
    const { steps, unusable } = buildContractFeeSteps({
      fee_schedule: [
        { effective_date: '2025-01-01', amount: 250, period: 'per_visit', quote: '' },
        { effective_date: '2025-02-01', amount: 99, period: 'unknown', quote: '' },
      ],
    }, targets);
    expect(steps).toHaveLength(0);
    expect(unusable).toBe(2);
  });

  it('an empty or absent schedule produces nothing at all', () => {
    expect(buildContractFeeSteps({}, targets)).toEqual({ steps: [], undated: 0, unusable: 0 });
    expect(buildContractFeeSteps(null, targets).steps).toHaveLength(0);
  });
});

describe('contractTargets — what the contract WILL BE', () => {
  it('takes the changed value, else the contract’s own', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { amount: f(8000) } });
    const t = contractTargets(CONTRACT, ch);
    expect(t.amount).toBe(8000);
    expect(t.frequency).toBe('annual');     // unchanged by the document
    expect(t.startDate).toBe('2024-11-01'); // unchanged by the document
  });
});

describe('hasNoContractChanges', () => {
  it('is true for a document that restates the contract', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { amount: f(7000) } });
    expect(hasNoContractChanges(ch)).toBe(true);
  });

  // ⚠ The step counts and both date lists COUNT. A document whose only content is a fee
  // table with no anchorable date would otherwise read as "nothing to update", the dialog
  // would offer Done, and the warning naming those dropped rows would never render.
  it('is FALSE when the only content is steps that were dropped', () => {
    const plan = buildContractFeeSteps({
      fee_schedule: [{ effective_date: null, months_from_start: 12, amount: 7500, period: 'per_year', quote: '' }],
    }, { frequency: 'annual', startDate: null });
    const ch = contractChanges({ contract: CONTRACT, extraction: {}, plan });
    expect(ch.fields).toHaveLength(0);
    expect(hasNoContractChanges(ch)).toBe(false);
  });

  it('is FALSE when the only content is an unusable date', () => {
    const ch = contractChanges({ contract: CONTRACT, extraction: { end_date: f('2033-04-31') } });
    expect(hasNoContractChanges(ch)).toBe(false);
  });
});

describe('noticeDueDate', () => {
  it('is end_date minus the notice days', () => {
    expect(noticeDueDate('2026-10-31', 30)).toBe('2026-10-01');
    expect(noticeDueDate('2026-01-15', 45)).toBe('2025-12-01');
  });

  // A notice date must never be invented — it is the date a landlord will act on.
  it('is null without both a usable end date and a positive window', () => {
    expect(noticeDueDate(null, 30)).toBe(null);
    expect(noticeDueDate('2026-10-31', null)).toBe(null);
    expect(noticeDueDate('2026-10-31', 0)).toBe(null);
    expect(noticeDueDate('2033-04-31', 30)).toBe(null); // not a real day
  });
});

describe('buildContractConfidence', () => {
  it('collects the per-field confidences under the CONTRACT’s own keys', () => {
    const map = buildContractConfidence({
      amount: f(8000, 0.96),
      cancellation_notice_days: f(30, 0.8),
      vendor: 'a bare string carries no confidence',
    });
    expect(map).toEqual({ amount: 0.96, notice_days: 0.8 });
  });

  it('is null when nothing carried a confidence', () => {
    expect(buildContractConfidence({ amount: 8000 })).toBe(null);
  });
});
