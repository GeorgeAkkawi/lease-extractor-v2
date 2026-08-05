// The AI intake review screen's schedule panel, MOUNTED.
//
// It shipped with a reference to an undeclared `rentStart` — the local was deleted when this
// panel was switched to the shared buildScheduleFromExtraction, and the JSX below it that
// still read the local came along untouched. Because the reference sits behind
// `freeMo > 0 && start &&`, short-circuit evaluation meant it threw ONLY for a lease with a
// leading free-rent period — which is precisely the case the same round newly made reachable
// (an undated free-rent window now anchors to the lease start instead of being dropped). So
// the first landlord to upload a lease with three months free got a blank page.
//
// Nothing caught it because nothing mounted this component: the builder is unit-tested as a
// pure function, and the page around it is never rendered. Hence this file.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SchedulePreview } from '../LeaseNewPage';

const field = (value) => ({ value, confidence: 0.9, source_quote: '', page: 1 });

// A lease with THREE MONTHS FREE and a readable start — the exact shape that threw.
const FREE_RENT_LEASE = {
  base_rent: field(120000),
  lease_start: field('2026-01-01'),
  lease_termination_date: field('2030-12-31'),
  abatements: [{ start_date: null, months: 3, kind: 'free' }],
  escalations: [
    { effective_date: null, months_from_start: 12, escalation_type: 'percent', escalation_value: 3 },
  ],
  renewal_options: [],
};

describe('SchedulePreview', () => {
  it('renders for a lease with a leading free-rent period', () => {
    render(<SchedulePreview ex={FREE_RENT_LEASE} />);
    // The note that names the commencement date is the one that used to throw.
    expect(screen.getByText(/3 months/i)).toBeTruthy();
    expect(screen.getByText(/paid rent starts/i)).toBeTruthy();
    // …and it names the date the steps are actually dated from — three months in, not the
    // term start. Getting this wrong bills a step-up before it is owed.
    expect(screen.getByText(/April 1, 2026/)).toBeTruthy();
  });

  it('renders for a lease with no free rent at all', () => {
    render(<SchedulePreview ex={{ ...FREE_RENT_LEASE, abatements: [] }} />);
    expect(screen.queryByText(/paid rent starts/i)).toBeNull();
  });

  it('renders for an extraction with nothing in it', () => {
    render(<SchedulePreview ex={{}} />);
    expect(document.body.textContent).toBeTruthy();
  });
});
