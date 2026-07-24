// The expense entry, driven through the real components against the demo mock:
//  • a management fee is entered as a PERCENTAGE of base rent and the form works the
//    dollars out (George: "when it is clicked i need it to offer a percentage of base
//    rent as that calcuation then it needs to be added to the expenses");
//  • property taxes read like the CAM list — one line per payment.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CamSection from '../CamSection';
import TaxSection from '../TaxSection';
import { listCamLineItems, listTaxLineItems, deleteCamLineItem, deleteTaxLineItem, getExpenseRecord, upsertExpenseRecord } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const P = 'prop-1';
const SEED = { taxes_total: 25000, cam_total: 18000, roof_total: 4000 };

const wrap = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => cleanup());
afterEach(async () => {
  for (const it of await listTaxLineItems(P, Y)) await deleteTaxLineItem(it.id, P, Y);
  for (const it of await listCamLineItems(P, Y)) if (it.rent_pct != null) await deleteCamLineItem(it.id, P, Y);
  await upsertExpenseRecord({ property_id: P, year: Y, ...SEED });
});

describe('CAM entry — a management fee is a percentage', () => {
  it('offers the percentage as soon as the label says so, and prices it off the rent', async () => {
    wrap(<CamSection propId={P} year={Y} expense={{ ...SEED }} />);
    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());

    // A dollar field until the line is named like a fee.
    expect(document.querySelector('.cam-pre').textContent).toBe('$');
    fireEvent.change(screen.getByPlaceholderText('e.g. Landscaping'), { target: { value: 'Management fee' } });
    await waitFor(() => expect(screen.getByPlaceholderText('5')).toBeTruthy());

    // 5% of the property's $144,000 base rent — worked out, not typed.
    fireEvent.change(screen.getByPlaceholderText('5'), { target: { value: '5' } });
    await waitFor(() => expect(screen.getByText(/5% of \$144,000\.00 base rent =/)).toBeTruthy());
    expect(screen.getByText('$7,200.00')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Add expense item'));
    // It bills like any other component, and the row says what it was struck at.
    await waitFor(() => expect(screen.getByText('Management fee')).toBeTruthy());
    expect(screen.getByText('5% of $144,000.00 base rent')).toBeTruthy();
    expect(screen.getByText('$25,200.00')).toBeTruthy(); // CAM total 18,000 + 7,200
  });
});

describe('Property taxes — itemized', () => {
  it('takes a payment at a time, totals them, and never drops the figure already entered', async () => {
    wrap(<TaxSection propId={P} year={Y} expense={{ ...SEED }} />);
    // Nothing itemized yet → the year's total is still enterable as one figure.
    await waitFor(() => expect(screen.getByText(/No tax payments itemized yet/)).toBeTruthy());
    expect(screen.getByText(/Year's tax total/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Cook County — 1st instalment/), { target: { value: 'Cook County — 1st instalment' } });
    fireEvent.change(screen.getByPlaceholderText('0'), { target: { value: '3100' } });
    fireEvent.click(screen.getByTitle('Add tax payment'));

    await waitFor(() => expect(screen.getByText('Cook County — 1st instalment')).toBeTruthy());
    // The $25,000 already on file became its own line rather than disappearing.
    expect(screen.getByText('Entered by hand')).toBeTruthy();
    expect(screen.getByText('$28,100.00')).toBeTruthy();
    expect(Number((await getExpenseRecord(P, Y)).taxes_total)).toBe(28100);
    // With lines on the page, the single-figure entry steps aside.
    expect(screen.queryByText(/Year's tax total/)).toBe(null);
  });
});
