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
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
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
    // The by-category roll-up (0075) also names buckets and repeats their totals, so a
    // bare getByText is ambiguous now. Scoping OUT the summary makes these assertions
    // stricter than they were — they now pin the itemized rows specifically.
    const inItems = (text) => screen.getAllByText(text).filter((el) => !el.closest('.cat-summary'));
    await waitFor(() => expect(inItems('Landscaping').length).toBe(1));
    // The not-billed group renders its own header, item, and total…
    expect(screen.getByText('Other expenses — not billed to tenants')).toBeTruthy();
    expect(inItems('Owner legal fees').length).toBe(1);
    expect(screen.getByText('Other total')).toBeTruthy();
    // The 1,200 figure shows twice in the lists: the item row and the group's own total.
    expect(inItems('$1,200.00').length).toBe(2);
    // …while the CAM total sums ONLY the billable items (8,000+4,000+6,000).
    expect(screen.getByText('CAM total')).toBeTruthy();
    expect(inItems('$18,000.00').length).toBe(1);
    // The add form offers the not-billed choice + the bucket datalist.
    expect(screen.getByText('not billed')).toBeTruthy();
    expect(document.getElementById('cam-bucket-list')).toBeTruthy();
  });

  // Slice 2 — the roll-up, and the refusal that makes it worth having. The demo seed is
  // deliberately one of each state: two buckets on Amlak's defaults, one bucket a human
  // chose, and one ('Security') with no honest default at all.
  it('rolls buckets up by tax category and refuses to absorb an unanswered one', async () => {
    withProviders(<CamSection propId="prop-1" year={Y} expense={{ taxes_total: 25000, cam_total: 18000, roof_total: 4000 }} />);
    await waitFor(() => expect(screen.getByText('These lines by tax category')).toBeTruthy());
    const summary = document.querySelector('.cat-summary');

    // Landscaping 8,000 + Snow removal 4,000 both default to Cleaning and maintenance.
    expect(within(summary).getByText('Cleaning and maintenance')).toBeTruthy();
    expect(within(summary).getByText('$12,000.00')).toBeTruthy();
    // Owner legal fees carries a SAVED category, and is counted even though it is not
    // billed to tenants — a cost you absorb is still a deductible expense.
    expect(within(summary).getByText('Legal and professional')).toBeTruthy();
    expect(within(summary).getByText('$1,200.00')).toBeTruthy();

    // THE refusal: Security has no defensible default, so its $6,000 stands on its own
    // as a figure that wants an answer — never folded into the "Other" category, which
    // is how a miscellaneous line becomes a place to hide things.
    const none = summary.querySelector('.cat-none');
    expect(none).toBeTruthy();
    expect(within(none).getByText('Not categorized')).toBeTruthy();
    expect(within(none).getByText('$6,000.00')).toBeTruthy();
    expect(within(none).getByText(/Security/)).toBeTruthy();
    expect(within(summary).queryByText('Other')).toBeNull();

    // Every bucket offers its category inline; the unanswered one asks for it.
    expect(screen.getByText('Set a tax category')).toBeTruthy();
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
