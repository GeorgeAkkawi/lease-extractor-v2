// The properties named under one cause have to ADD UP to the figure beside them.
//
// ⚠ WHY THIS FILE EXISTS. George, 2026-08-18: *"tell me where that figure comes from
// '3,977.85'"* — and the app had never printed $3,977.85. A cause on his Overview listed its
// properties through `money(Math.abs(...))`, so the one property pulling the OTHER way lost its
// minus sign, the rows visibly failed to add to the headline beside them, and the two that
// agreed summed to a figure the app never computed. The line it happened on (the annual-rate
// caveat) was retired the next day, but the display rule is general and stays pinned here:
// when the properties under a cause pull in different directions, every row carries its sign.
//
// This is the same duty `yearBridge`'s sub-dollar fold keeps on the data side — when a term
// absorbs another it moves the EVIDENCE, not just the amount — because the row list is the one
// thing on this panel a landlord can check by eye.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BasisBridge from '../BasisBridge';
import { yearBridge } from '../../lib/yearBridge';

const Y = 2026;

// A property whose ONLY cause is a base-rent correction: posted carries the correction and the
// cash followed it exactly, so `pastDue` is zero and `corrections` is the one term raised.
// Corrections are signed either way — a charge up, a credit down — which makes them the natural
// home of the mixed-sign case now that every timing term pulls one way by construction.
const row = (id, name, rent, corr) => ({
  id, name,
  rentProjected: rent, rentLive: rent + corr, rentScheduled: rent,
  rentPosted: rent + corr, rentCorrections: corr,
  projectedAhead: 0, rentNotDue: 0, camTaxNotDue: 0,
  grossCarve: 0, tenantCredit: 0, unbilled: 0,
  camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0,
  chargesProjected: 0, chargesLive: 0, otherLive: 0, unapplied: 0, driftTotal: 0,
  totalProjected: rent, totalLive: rent + corr,
});

const openTerms = (bridge) => {
  render(<MemoryRouter><BasisBridge bridge={bridge} year={Y} /></MemoryRouter>);
  fireEvent.click(document.querySelector('button.panel-toggle'));
  return document.querySelector('.basis-bridge-body').textContent.replace(/\s+/g, ' ');
};

beforeEach(() => cleanup());

describe('the properties behind a cause', () => {
  // The cents are George's own — the three contributions whose unsigned rendering produced the
  // figure he had to ask about.
  it('signs a property that pulls the other way, so the rows net to the headline', () => {
    const bridge = yearBridge([
      row('p1', 'Pershing Plaza', 300000, 3956.23),
      row('p2', 'Cedar Court', 360000, -3038.60),
      row('p3', 'Joliet', 350000, 21.62),
    ], { year: Y });

    const revenue = bridge.measures.find((m) => m.key === 'revenue');
    const corr = revenue.terms.find((t) => t.key === 'corrections');
    expect(corr.amount).toBeCloseTo(939.25, 2);
    // The rows must genuinely net to it — if they ever stop, the display is not the problem.
    expect(corr.rows.reduce((s, r) => s + r.amount, 0)).toBeCloseTo(corr.amount, 2);

    const text = openTerms(bridge);
    expect(text).toContain('Pershing Plaza +$3,956.23');
    expect(text).toContain('Cedar Court −$3,038.60');
    expect(text).toContain('Joliet +$21.62');
    // ⚠ THE REGRESSION ITSELF. Unsigned, Cedar Court reads as another $3,038.60 pulling the same
    // way, and the two rows that agree add to a figure the app never computed.
    expect(text).not.toContain('Cedar Court $3,038.60');
  });

  // A column of identical minus signs states nothing and costs the line its readability — every
  // timing line in the panel is this shape, and it was never the confusing one.
  it('leaves signs off when every property pulls the same way', () => {
    const bridge = yearBridge([
      row('p1', 'Pershing Plaza', 300000, 4000),
      row('p2', 'Joliet', 350000, 1000),
    ], { year: Y });

    const text = openTerms(bridge);
    expect(text).toContain('Pershing Plaza $4,000.00');
    expect(text).toContain('Joliet $1,000.00');
    expect(text).not.toContain('+$4,000.00');
  });

  // One property is not a list: its name is already the whole answer, and a trailing chip
  // repeating it is noise. Unchanged by the signing — pinned so it stays that way.
  it('names no properties at all when there is only one', () => {
    const bridge = yearBridge([row('p1', 'Pershing Plaza', 300000, 4000)], { year: Y });
    const text = openTerms(bridge);
    expect(text).toContain('$4,000.00');
    expect(screen.queryByText(/Pershing Plaza/)).toBeNull();
  });
});
