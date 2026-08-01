// Slice 5a in the DOM.
//
// The demo seed carries one of every case: a building placed in APRIL (so its first
// year is prorated), a roof placed on January 1 (so it isn't), a parking lot on a
// 15-year life, and — on prop-2 — a building with NO land allocation, which is the gold
// refusal this round exists to make.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import AssetRegisterSection from '../AssetRegisterSection';
import WhatStayedStrip from '../WhatStayedStrip';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const withProviders = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const rowFor = (text) => [...document.querySelectorAll('.asset-row')].find((r) => r.textContent.includes(text));

beforeEach(() => cleanup());

describe('What you own', () => {
  it('shows each asset’s cost, this year’s depreciation and what it is worth on the books', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Maple Plaza — structure')).toBeTruthy());
    expect(screen.getByText(`What you own · FY ${Y}`)).toBeTruthy();

    // $936,000 of basis over 39 years = exactly $24,000 a year.
    expect(within(rowFor('Maple Plaza — structure')).getByText('$24,000.00')).toBeTruthy();
    expect(within(rowFor('Roof replacement')).getByText('$500.00')).toBeTruthy();
    expect(within(rowFor('Parking lot resurfacing')).getByText('$2,800.00')).toBeTruthy();

    // Totals summed from the rows shown: 24,000 + 500 + 2,800 and 1,190,000 + 19,500 + 42,000.
    const total = document.querySelector('.asset-total');
    expect(within(total).getByText('$27,300.00')).toBeTruthy();
    expect(within(total).getByText('$1,251,500.00')).toBeTruthy();
  });

  it('names the life and the land, so the figures can be checked by hand', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Maple Plaza — structure')).toBeTruthy());
    const row = rowFor('Maple Plaza — structure').textContent;
    expect(row).toContain('Building');
    expect(row).toContain('39 yr');
    expect(row).toContain('land $254,000.00');
  });

  // ⚠ THE REFUSAL THIS ROUND TURNS ON. The land/building split is an allocation
  // decision, not a fact on the settlement statement — so a building nobody has split
  // does not depreciate, and says which answer is missing rather than reporting $0.
  it('refuses to depreciate a building whose land has never been valued', async () => {
    withProviders(<AssetRegisterSection propId="prop-2" year={Y} />);
    await waitFor(() => expect(screen.getByText('Oak Center — structure')).toBeTruthy());
    const row = rowFor('Oak Center — structure');
    expect(row.className).toContain('asset-blocked');
    // "—", never $0: a fully-depreciated asset legitimately reads $0 and the two must
    // not look alike.
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(row).getByText('Set the land value')).toBeTruthy();
    // Its cost is still real — a building you cannot yet depreciate is still owned —
    // and its book value equals that cost EXACTLY BECAUSE nothing has been taken. Both
    // columns read $800,000, which is the correct answer twice, not a duplicate.
    expect(within(row).getAllByText('$800,000.00')).toHaveLength(2);
    expect(document.body.textContent).toContain('1 not depreciating yet');
  });

  it('unblocks the schedule the moment the land is answered', async () => {
    withProviders(<AssetRegisterSection propId="prop-2" year={Y} />);
    await waitFor(() => expect(screen.getByText('Set the land value')).toBeTruthy());
    fireEvent.click(screen.getByText('Set the land value'));
    fireEvent.change(screen.getByPlaceholderText('Land value'), { target: { value: '215000' } });
    fireEvent.click(screen.getByText('Save'));
    // 800,000 − 215,000 = 585,000 over 39 years = exactly $15,000 a year.
    await waitFor(() => expect(within(rowFor('Oak Center — structure')).getByText('$15,000.00')).toBeTruthy());
    expect(rowFor('Oak Center — structure').className).not.toContain('asset-blocked');
  });

  // Two independent sources for one number — this schedule, and the figure on the
  // accountant's last return. Neither derived from the other.
  it('checks the accountant’s accumulated figure against its own', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Maple Plaza — structure')).toBeTruthy());
    expect(within(rowFor('Maple Plaza — structure')).getByText(/Matches your accountant’s figure through/)).toBeTruthy();
  });

  it('says on its face that none of this is cash and none of it moves a bill', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Maple Plaza — structure')).toBeTruthy());
    const body = document.body.textContent;
    expect(body).toMatch(/non-cash/i);
    expect(body).toMatch(/does\s+not\s+remove it from your expenses/i);
  });

  it('pre-fills the life from the kind and asks for land only where land exists', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Maple Plaza — structure')).toBeTruthy());
    fireEvent.click(screen.getByText('＋ Record one'));

    // Building improvement is the default kind — 39 years, and no land question,
    // because a roof has no land in it.
    expect(screen.getByPlaceholderText('Life — 39 yr')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Of which, land')).toBeNull();

    const kindSel = screen.getByDisplayValue('Building improvement');
    fireEvent.change(kindSel, { target: { value: 'land_improvement' } });
    expect(screen.getByPlaceholderText('Life — 15 yr')).toBeTruthy();

    fireEvent.change(kindSel, { target: { value: 'building' } });
    expect(screen.getByPlaceholderText('Of which, land')).toBeTruthy();
  });
});

// ⚠ Depreciation never crossed the bank, so it is deliberately ABSENT from the strip
// that answers what is in the account. Adding it there would be the tidiest possible
// lie — a cash figure with a non-cash number subtracted from it.
describe('What actually stayed, which depreciation stays out of', () => {
  it('does not subtract depreciation from the cash that stayed', async () => {
    withProviders(<WhatStayedStrip propId="prop-1" year={Y} noi={100000} />);
    await waitFor(() => expect(screen.getByText(`What actually stayed · FY ${Y}`)).toBeTruthy());
    expect(screen.queryByText(/Depreciation/i)).toBeNull();
    // Unchanged by this round: 100,000 + 2,690 + 5,000 − 1,200 − 1,750 − 24,000.
    const rows = [...document.querySelectorAll('.stayed-row')];
    expect(rows.find((r) => r.textContent.includes('What actually stayed')).textContent).toContain('$80,740.00');
  });
});
