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
    // The not-billed group renders its own header, items, and total…
    expect(screen.getByText('Other expenses — not billed to tenants')).toBeTruthy();
    expect(screen.getByText('Owner legal fees')).toBeTruthy();
    expect(screen.getByText('$1,200.00')).toBeTruthy();
    // Since the entity ledger was retired (2026-08-12) this group is also where owner
    // money and LLC costs live — the distribution named for the person who took it,
    // and the franchise tax.
    expect(screen.getByText('Dana Whitfield')).toBeTruthy();
    expect(screen.getByText('$24,000.00')).toBeTruthy();
    expect(screen.getByText('Illinois franchise tax')).toBeTruthy();
    expect(screen.getByText('$1,750.00')).toBeTruthy();
    expect(screen.getByText('Other total')).toBeTruthy();
    expect(screen.getByText('$26,950.00')).toBeTruthy(); // 1,200 + 24,000 + 1,750

    // ⚠ …AND THE CAM TOTAL IS UNMOVED BY ALL OF IT. This is the assertion the whole
    // retirement rests on: $25,750 of owner money now sits on this page, and the figure
    // that bills tenants still sums only the billable items (8,000+4,000+6,000). If
    // syncCamTotal ever stopped filtering `billable === false`, a distribution would
    // start billing back to every tenant on the property, and this is what catches it.
    expect(screen.getByText('CAM total')).toBeTruthy();
    expect(screen.getByText('$18,000.00')).toBeTruthy();
    // The add form offers the not-billed choice + the remembered-label picker.
    expect(screen.getByText('not billed')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Expense name' })).toBeTruthy();
  });

  // The picker that replaced the native <datalist> (2026-08-18). Asserted by BEHAVIOUR, not
  // by an element id: the old test only proved a <datalist> node existed, which stayed true
  // however badly the browser drew it — the very thing George was complaining about.
  it('offers remembered labels on focus, each with the category it will file under', async () => {
    withProviders(<CamSection propId="prop-1" year={Y} expense={{ taxes_total: 25000, cam_total: 18000, roof_total: 4000 }} />);
    await waitFor(() => expect(screen.getByText('CAM total')).toBeTruthy());
    const box = screen.getByRole('combobox', { name: 'Expense name' });

    // Shut until asked for — the field is a text box first.
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.focus(box);
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeTruthy();

    // A label already used on this property is offered, carrying the category the chip
    // beside its bucket shows — one `categoryFor`, not two guesses.
    const opts = screen.getAllByRole('option').map((o) => o.textContent);
    expect(opts.some((t) => t.includes('Landscaping'))).toBe(true);
    expect(opts.some((t) => t.includes('Landscaping') && /maintenance/i.test(t))).toBe(true);

    // Typing filters, and picking fills the box.
    fireEvent.change(box, { target: { value: 'snow' } });
    const filtered = screen.getAllByRole('option').map((o) => o.textContent);
    expect(filtered.some((t) => t.includes('Snow removal'))).toBe(true);
    expect(filtered.some((t) => t.includes('Landscaping'))).toBe(false);
    const snowOpt = screen.getAllByRole('option').find((o) => o.textContent.includes('Snow removal'));
    fireEvent.mouseDown(snowOpt.querySelector('button') || snowOpt);
    expect(box.value).toBe('Snow removal');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  // ⚠ FREE TEXT SURVIVES. The offered list is derived from use, so a name nobody has typed
  // before is the normal case for a new bucket — not an error state.
  it('lets a brand-new name be typed straight through, with no match offered', async () => {
    withProviders(<CamSection propId="prop-1" year={Y} expense={{ taxes_total: 25000, cam_total: 18000, roof_total: 4000 }} />);
    await waitFor(() => expect(screen.getByText('CAM total')).toBeTruthy());
    const box = screen.getByRole('combobox', { name: 'Expense name' });
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Koi pond dredging' } });
    expect(box.value).toBe('Koi pond dredging');
    // Nothing matches, so no list stands between the landlord and the ＋ button.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  // Slice 2's chips: three states on one seeded property — two buckets riding Amlak's
  // defaults, one a human chose, and one ('Security') with no honest default at all.
  // The ROLL-UP those chips feed moved to RecoverabilityTable in Slice 3, and is
  // rendered-tested in recoverabilityUi.test.js.
  it('offers every bucket its category inline, and asks about the one with no default', async () => {
    withProviders(<CamSection propId="prop-1" year={Y} expense={{ taxes_total: 25000, cam_total: 18000, roof_total: 4000 }} />);
    await waitFor(() => expect(screen.getByText('Set a tax category')).toBeTruthy());
    const chips = [...document.querySelectorAll('.cat-chip')];
    // Chosen reads solid, Amlak's default reads dashed, and unanswered reads gold — a
    // derived answer must never pose as a decision.
    expect(chips.some((c) => c.className === 'cat-chip')).toBe(true);            // saved
    expect(chips.some((c) => c.className.includes('derived'))).toBe(true);       // default
    expect(chips.some((c) => c.className.includes('none'))).toBe(true);          // unanswered
    // …and the unanswered one ASKS rather than naming a category it hasn't got.
    expect(chips.find((c) => c.className.includes('none')).textContent).toBe('Set a tax category');
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
