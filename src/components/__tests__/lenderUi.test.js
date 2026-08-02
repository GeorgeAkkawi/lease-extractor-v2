// Slice 7c in the DOM. Mounts the REAL corporation grid and the REAL lender modal
// against the demo mock.
//
// What matters here is not that figures render — it is that the screen refuses to state
// a ratio it cannot compute, and states the forward one the moment it can. A package
// that prints "0.00×" because nobody typed a debt service reads as a failing building;
// one that prints today's DSCR and stops has left out the only part a lender argues
// about.
//
// The demo seed carries the cases at once on Maple Plaza: City Dental's term ended in
// May 2026 so it is holding over, Bright Coffee runs well past, and the property's
// expenses are entered — so the NOI gap against the Financials page is real.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CorporationsPage from '../../pages/CorporationsPage';
import ExportLenderModal from '../ExportLenderModal';
import { ChromeProvider } from '../../context/ChromeContext';
import { currentYear } from '../../lib/format';

const Y = currentYear();

const withProviders = (ui, path = '/financials') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>{ui}</ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const grid = (mode) => withProviders(
  <Routes><Route path={`/${mode}`} element={<CorporationsPage mode={mode} />} /></Routes>,
  `/${mode}`
);

const openModal = async () => {
  withProviders(<ExportLenderModal corporationId="corp-1" corporationName="Acme Holdings" year={Y} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText('Coverage')).toBeTruthy());
  return screen.getByRole('dialog');
};

const flagText = (dlg) => [...dlg.querySelectorAll('.cpa-flag')].map((f) => f.textContent).join(' ');
const stat = (dlg, label) => within(dlg).getByText(label).parentElement.querySelector('b').textContent;

beforeEach(() => cleanup());

// ⚠ Round 15 — see cpaExportUi for the full note. Five pills overflowed the card and
// the last three (this one included) were unclickable; counting the label stayed green
// the whole time. Drive the control instead. Exact name: the card is role="button" too.
const openDocs = async (mode) => {
  grid(mode);
  const btns = await screen.findAllByRole('button', { name: 'Documents & filings' });
  fireEvent.click(btns[0]);
  return await screen.findByRole('dialog');
};

describe('where the package is offered', () => {
  it('sits beside the tax package and the 1099 worksheet, behind the card’s one control', async () => {
    const panel = await openDocs('financials');
    expect(within(panel).getByRole('button', { name: /Lender package/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Tax package/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /1099s/ })).toBeTruthy();
  });

  it('is absent from the Portfolio tab', async () => {
    const panel = await openDocs('leases');
    expect(within(panel).queryByRole('button', { name: /Lender package/ })).toBeNull();
  });
});

describe('the ratio it refuses to state', () => {
  // ⚠ THE ONE THAT MATTERS. Amlak does not hold the loans, so with no debt service the
  // coverage is "—" — never 0.00×, which would read as a building that cannot pay.
  it('shows no coverage until a debt service is typed, and says why', async () => {
    const dlg = await openModal();
    expect(stat(dlg, 'Coverage')).toBe('—');
    expect(flagText(dlg)).toMatch(/coverage ratio is not computed/);
    expect(dlg.textContent).toMatch(/doesn’t hold your loans yet/);
    expect(dlg.textContent).toMatch(/not saved/);
    // Everything above the ratio still computes.
    expect(stat(dlg, 'Gross income')).toMatch(/^\$/);
    expect(stat(dlg, 'NOI')).toMatch(/^\$/);
  });

  it('computes the ratio once the debt service is entered', async () => {
    const dlg = await openModal();
    fireEvent.change(within(dlg).getByPlaceholderText('principal + interest'), { target: { value: '80000' } });
    await waitFor(() => expect(stat(dlg, 'Coverage')).toMatch(/×$/));
    expect(flagText(dlg)).not.toMatch(/coverage ratio is not computed/);
  });
});

describe('the forward read', () => {
  // The thing no accounting package can say, because none of them hold the leases.
  it('names the tenants rolling off and what leaving them costs', async () => {
    const dlg = await openModal();
    const fwd = dlg.querySelector('.lender-forward');
    expect(fwd.textContent).toMatch(/City Dental/);
    expect(fwd.textContent).toMatch(/rent and\s+reimbursement/);
    expect(fwd.textContent).toMatch(/their share becomes vacancy you carry/);
  });

  it('states the coverage it would fall to once a debt service is known', async () => {
    const dlg = await openModal();
    fireEvent.change(within(dlg).getByPlaceholderText('principal + interest'), { target: { value: '80000' } });
    await waitFor(() => expect(dlg.querySelector('.lender-forward').textContent).toMatch(/Coverage falls to/));
    const now = Number(stat(dlg, 'Coverage').replace('×', ''));
    const down = Number(dlg.querySelector('.lender-forward strong').textContent.match(/([\d.]+)×/)[1]);
    expect(down).toBeLessThan(now);
  });
});

describe('what it says about its own figures', () => {
  // ⚠ The app's NOI subtracts the whole expense and counts none of the reimbursement,
  // so it is LOWER than the underwritten one. Saying so is what keeps both trustworthy.
  it('names the gap against the NOI on the Financials page', async () => {
    const dlg = await openModal();
    expect(dlg.textContent).toMatch(/Amlak’s Financials page shows NOI of/);
    expect(dlg.textContent).toMatch(/lower than the figure above/);
    expect(dlg.textContent).toMatch(/without counting the reimbursement/);
  });

  it('warns that an unadjusted NOI is the optimistic one', async () => {
    const dlg = await openModal();
    expect(flagText(dlg)).toMatch(/reports YOUR NOI/);
    expect(flagText(dlg)).toMatch(/management fee and a replacement reserve whether or not you pay them/);
  });

  it('names the holdover tenant rather than leaving it in the rent roll', async () => {
    const dlg = await openModal();
    expect(flagText(dlg)).toMatch(/City Dental is holding over/);
    expect(flagText(dlg)).toMatch(/exposed today/);
  });
});

describe('the workbook itself', () => {
  // The only thing that proves all five sheets actually build: drive the real button.
  it('builds a real workbook from the Download button', async () => {
    const blobs = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
      const dlg = await openModal();
      fireEvent.change(within(dlg).getByPlaceholderText('principal + interest'), { target: { value: '80000' } });
      await waitFor(() => expect(stat(dlg, 'Coverage')).toMatch(/×$/));
      fireEvent.click(within(dlg).getByRole('button', { name: /Download Excel/ }));
      await waitFor(() => expect(blobs).toHaveLength(1));
      expect(blobs[0].size).toBeGreaterThan(5000);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  }, 30000);
});
