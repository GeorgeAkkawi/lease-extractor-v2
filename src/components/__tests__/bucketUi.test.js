// Render smokes for the expense-bucket UI (0064) against the demo mock:
//   • CamSection — the itemized list grouped into buckets, the "not billed to
//     tenants" group with its own total, and the CAM total excluding it.
//   • TenantShareTable's estimate editor — opens PRE-FILLED from the lease's
//     cached AI read ("from the lease" tag) for a tenant with no estimate set,
//     and Save adopts the figure onto the lease.
//
// Demo seed: prop-1 CAM items Landscaping 8,000 / Snow removal 4,000 / Security
// 6,000 (billable) + Owner legal fees 1,200 (billable:false). City Dental
// (lease-2, 3,000 SF, no estimate) links lease file lf-1 whose extraction_raw
// states $12,000/yr estimated CAM & tax ($4.00/SF).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CamSection from '../CamSection';
import TenantShareTable from '../TenantShareTable';
import { getLease, updateLease } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const withProviders = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
};

beforeEach(() => cleanup());

describe('CamSection — buckets + the not-billed group', () => {
  it('splits billable buckets from "not billed to tenants" with separate totals', async () => {
    withProviders(<CamSection propId="prop-1" year={Y} expense={{ taxes_total: 25000, cam_total: 18000, roof_total: 4000 }} />);
    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());
    // The not-billed group renders its own header, item, and total…
    expect(screen.getByText('Other expenses — not billed to tenants')).toBeTruthy();
    expect(screen.getByText('Owner legal fees')).toBeTruthy();
    expect(screen.getByText('Other total')).toBeTruthy();
    // The 1,200 figure shows twice: the item row and the group's own total.
    expect(screen.getAllByText('$1,200.00').length).toBe(2);
    // …while the CAM total sums ONLY the billable items (8,000+4,000+6,000).
    expect(screen.getByText('CAM total')).toBeTruthy();
    expect(screen.getByText('$18,000.00')).toBeTruthy();
    // The add form offers the not-billed choice + the bucket datalist.
    expect(screen.getByText('not billed')).toBeTruthy();
    expect(document.getElementById('cam-bucket-list')).toBeTruthy();
  });
});

describe('TenantShareTable — estimate editor pre-filled from the lease', () => {
  it('opens City Dental\'s editor with the lease-stated $4.00/SF and Save adopts it', async () => {
    withProviders(<TenantShareTable propertyId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('City Dental')).toBeTruthy());
    // No estimate saved → the affordance invites entry; open the editor.
    fireEvent.click(screen.getByText('＋ set estimate'));
    // The cached lease read pre-fills the $/SF input (12,000 / 3,000 SF = 4).
    await waitFor(() => expect(screen.getByText(/from the lease/)).toBeTruthy());
    const input = screen.getByLabelText(/CAM & tax \$\/SF\/yr/);
    expect(input.value).toBe('4');
    expect(screen.getByText(/\$4\.00 per square/)).toBeTruthy();
    // Save adopts the lease's figure onto the lease (combined into est_cam_annual).
    fireEvent.click(screen.getByText('Save'));
    await waitFor(async () => {
      const lease = await getLease('lease-2');
      expect(Number(lease.est_cam_annual)).toBe(12000);
      expect(Number(lease.est_tax_annual)).toBe(0);
    });
    // Reset the seed so other assertions about City Dental "billing actuals" hold.
    await updateLease('lease-2', { est_cam_annual: null, est_tax_annual: null, est_roof_annual: null });
  });
});
