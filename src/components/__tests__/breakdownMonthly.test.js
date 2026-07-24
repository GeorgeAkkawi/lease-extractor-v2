// Two render checks against the demo mock (DEMO mode forced by the test env):
//
//  1. The per-tenant breakdown states each figure's MONTHLY amount under the annual
//     (George: "need a monthly base rent in the per tenant break down under the
//     annual") — on base rent and on the all-in Total, which is the figure that ties
//     to that month's Ledger box and to a rider's own "Monthly rent" line.
//  2. The addendum review offers the CAM & tax estimate a rider states, pre-filled
//     from the read and stating its own monthly back.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TenantShareTable from '../TenantShareTable';
import AddendumEditor from '../AddendumEditor';
import { getLease } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const wrap = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{ui}</QueryClientProvider></MemoryRouter>);
};

beforeEach(() => cleanup());

describe('per-tenant breakdown — the monthly figure under the annual', () => {
  it('states base rent and the all-in total per month, beside the $/SF rate', async () => {
    wrap(<TenantShareTable propertyId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());

    // Bright Coffee: $60,000/yr base → $5,000.00/mo, and its $30.00/SF stays put.
    const row = screen.getByText('Bright Coffee Co.').closest('.ledger-row');
    expect(within(row).getByText('$5,000.00/mo')).toBeTruthy();
    expect(within(row).getByText(/\$30\.00\/SF/)).toBeTruthy();
    // Total = base 60,000 + estimate 16,500 + roof 1,500 = 78,000 → $6,500.00/mo,
    // which is exactly what its Ledger boxes read.
    expect(within(row).getByText('$6,500.00/mo')).toBeTruthy();

    // The Totals band carries the property's monthly rent roll too.
    const totals = document.querySelector('.ledger-totals');
    expect(within(totals).getByText('$12,000.00/mo')).toBeTruthy(); // 144,000 base / 12
  });
});

describe('addendum review — the CAM & tax estimate a rider states', () => {
  it('pre-fills the estimate the AI read, states its monthly, and applies it to the lease', async () => {
    wrap(<AddendumEditor leaseId="lease-1" squareFootage={2000} />);
    fireEvent.click(await screen.findByText('+ Add addendum / rider'));

    // Drive the AI lane (canned in demo — no model call, no cost).
    fireEvent.click(screen.getByText('Paste text instead'));
    fireEvent.change(screen.getByPlaceholderText(/Paste the addendum/), { target: { value: 'Real Estate Taxes & CAM: $1,500.00' } });
    fireEvent.click(screen.getByText('Extract with AI'));

    // The effect card arrives ON and filled: $1,500.00/mo → $18,000 annual, exactly.
    await waitFor(() => expect(screen.getByText('Sets the CAM & tax estimate')).toBeTruthy());
    const card = screen.getByText('Sets the CAM & tax estimate').closest('.callout');
    expect(card.querySelector('input[type="checkbox"]').checked).toBe(true);
    expect(within(card).getByDisplayValue('18000')).toBeTruthy();
    // Riders print the figure monthly, so the field says its own monthly back — and
    // the $/SF rate, which is what the Financials editor takes.
    expect(within(card).getByText(/= \$1,500\.00\/mo · \$9\.00\/SF\/yr/)).toBeTruthy();
    expect(within(card).getByText(/Real Estate Taxes & CAM/)).toBeTruthy(); // the rider's own words

    // Saving writes it as the ONE combined figure the app bills from.
    fireEvent.click(screen.getByText('Save & apply'));
    await waitFor(async () => {
      const lease = await getLease('lease-1');
      expect(Number(lease.est_cam_annual)).toBe(18000);
      expect(Number(lease.est_tax_annual)).toBe(0);
    });
  });
});
