// The properties named under one cause have to ADD UP to the figure beside them.
//
// ⚠ WHY THIS FILE EXISTS. George, 2026-08-18: *"tell me where that figure comes from
// '3,977.85'"* — and the app had never printed $3,977.85. His annual-rate caveat read
//
//     $939.25  the annual rate the Financials page quotes …
//              Pershing Plaza $3,956.23 · 401 S Main $3,038.60 · Joliet $21.62
//
// every row stripped to its absolute value by `money(Math.abs(...))`. 401 S Main is really
// **−$3,038.60** — it is the one property whose scheduled rent runs AHEAD of the annual rate — so
// the three do net to $939.25. Nothing on the line said so, so the two rows that agreed summed to
// $3,977.85 and the headline looked invented.
//
// This is the one thing a landlord can actually check by eye on that panel, which is exactly why
// `yearBridge`'s sub-dollar fold already moves a term's EVIDENCE and not just its amount. The
// display had the same duty and was not keeping it.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BasisBridge from '../BasisBridge';
import { yearBridge } from '../../lib/yearBridge';

const Y = 2026;

// A property with nothing to explain on any measure, so the only line the panel can raise is the
// one under test. `rate` is what the Financials page would quote for the same year.
const row = (id, name, rent, rate) => ({
  id, name,
  rentProjected: rent, rentLive: rent, rentScheduled: rent, rentPosted: rent,
  projectedAhead: 0, rentAnnualRate: rate,
  grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
  camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0,
  chargesProjected: 0, chargesLive: 0, otherLive: 0, unapplied: 0, driftTotal: 0,
  totalProjected: rent, totalLive: rent,
});

const openPanel = (bridge) => {
  render(<MemoryRouter><BasisBridge bridge={bridge} year={Y} /></MemoryRouter>);
  fireEvent.click(document.querySelector('button.panel-toggle'));
  return document.querySelector('.basis-bridge-caveats').textContent.replace(/\s+/g, ' ');
};

beforeEach(() => cleanup());

describe('the properties behind a cause', () => {
  // George's own FY 2026 figures, to the cent.
  it('signs a property that pulls the other way, so the rows net to the headline', () => {
    const bridge = yearBridge([
      row('p1', 'Pershing Plaza', 309078.73, 313034.96),   // +3,956.23 — the rate runs ahead
      row('p2', '401 S Main', 367667.72, 364629.12),       // −3,038.60 — the schedule runs ahead
      row('p3', 'Joliet', 354877.90, 354899.52),           //    +21.62
    ], { year: Y });

    const caveat = bridge.caveats.find((c) => c.key === 'annualRate');
    expect(caveat.amount).toBeCloseTo(939.25, 2);
    // The rows must genuinely net to it — if they ever stop, the display is not the problem.
    expect(caveat.rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(caveat.amount, 2);

    const text = openPanel(bridge);
    expect(text).toContain('$939.25');
    expect(text).toContain('Pershing Plaza +$3,956.23');
    expect(text).toContain('401 S Main −$3,038.60');
    expect(text).toContain('Joliet +$21.62');
    // ⚠ THE REGRESSION ITSELF. Unsigned, 401 S Main reads as another $3,038.60 pulling the same
    // way, and the two rows that agree add to the figure George asked me to explain.
    expect(text).not.toContain('401 S Main $3,038.60');
  });

  // A column of identical minus signs states nothing and costs the line its readability — every
  // arrears line in the panel is this shape, and it was never the confusing one.
  it('leaves signs off when every property pulls the same way', () => {
    const bridge = yearBridge([
      row('p1', 'Pershing Plaza', 300000, 304000),
      row('p2', 'Joliet', 350000, 351000),
    ], { year: Y });

    const text = openPanel(bridge);
    expect(text).toContain('Pershing Plaza $4,000.00');
    expect(text).toContain('Joliet $1,000.00');
    expect(text).not.toContain('+$4,000.00');
  });

  // One property is not a list: its name is already the whole answer, and a trailing chip
  // repeating it is noise. Unchanged by the signing — pinned so it stays that way.
  it('names no properties at all when there is only one', () => {
    const bridge = yearBridge([row('p1', 'Pershing Plaza', 300000, 304000)], { year: Y });
    const text = openPanel(bridge);
    expect(text).toContain('$4,000.00');
    expect(screen.queryByText(/Pershing Plaza/)).toBeNull();
  });
});
