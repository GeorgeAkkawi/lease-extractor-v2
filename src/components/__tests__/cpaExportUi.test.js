// Slice 7a in the DOM. Mounts the REAL corporation grid and the REAL export modal
// against the demo mock.
//
// The assertion that matters is not "does it download" — it is that the screen states
// what the package will be MISSING before it leaves. A tax package that quietly files
// uncategorized money as "Other", or quietly drops every expense a cash basis cannot
// date, is worse than no package: it looks finished.
//
// The demo seed carries both cases on Maple Plaza at once: "Security" ($6,000) has no
// tax category AND no payment date, and property taxes are a flat $25,000 nobody ever
// itemized — so a cash basis cannot place either.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CorporationsPage from '../../pages/CorporationsPage';
import ExportCpaModal from '../ExportCpaModal';
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
  withProviders(<ExportCpaModal corporationId="corp-1" corporationName="Acme Holdings" year={Y} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText('What’s in it')).toBeTruthy());
  return screen.getByRole('dialog');
};

beforeEach(() => cleanup());

describe('where the package is offered', () => {
  it('sits with the entity’s other paperwork on the Financials card', async () => {
    grid('financials');
    expect(await screen.findAllByText('Tax package')).toHaveLength(2); // one per corporation
  });

  // A tax package is a financials act. The Portfolio tab lists tenants and has no
  // business carrying it.
  it('is absent from the Portfolio tab', async () => {
    grid('leases');
    await screen.findByText('Acme Holdings');
    expect(screen.queryByText('Tax package')).toBeNull();
  });
});

describe('the pre-flight, before anything downloads', () => {
  it('states what the package will carry', async () => {
    const dlg = await openModal();
    expect(within(dlg).getByText('Properties')).toBeTruthy();
    expect(within(dlg).getByText('Income')).toBeTruthy();
    expect(within(dlg).getByText('Expenses')).toBeTruthy();
    // Named for both forms, because which one is filed is the accountant's call.
    expect(dlg.textContent).toMatch(/Form 8825/);
    expect(dlg.textContent).toMatch(/Schedule E/);
  });

  // ⚠ THE ONE THAT MAKES THE PACKAGE TRUSTWORTHY. $6,000 of "Security" has no category,
  // and it is surfaced here rather than filed as "Other" inside a workbook nobody reads.
  it('names the money that has no tax category, and refuses to call it Other', async () => {
    const dlg = await openModal();
    const flags = [...dlg.querySelectorAll('.cpa-flag')].map((f) => f.textContent).join(' ');
    expect(flags).toMatch(/\$6,000\.00 has no tax category/);
    expect(flags).toMatch(/rather than being filed as “Other”/);
  });

  it('says what is deliberately left off, so nothing reads as missed', async () => {
    const dlg = await openModal();
    // The seeded $24,000 draw, $5,000 contribution and $1,750 entity cost.
    expect(dlg.textContent).toMatch(/deliberately left off/);
  });
});

describe('the workbook itself', () => {
  // The only thing that proves all five sheets actually build: drive the real button.
  // jsdom has no URL.createObjectURL, so the download hook is shimmed — everything up to
  // and including ExcelJS writing the buffer is the real code path.
  it('builds a real five-sheet workbook from the Download button', async () => {
    const blobs = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
      const dlg = await openModal();
      fireEvent.click(within(dlg).getByRole('button', { name: /Download Excel/ }));
      await waitFor(() => expect(blobs).toHaveLength(1));
      // A five-sheet xlsx with figures in it — not an empty shell.
      expect(blobs[0].size).toBeGreaterThan(4000);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  }, 30000);
});

describe('the basis switch', () => {
  it('starts on accrual — the figures every other screen already shows', async () => {
    const dlg = await openModal();
    expect(within(dlg).getByRole('button', { name: 'Accrual' }).className).toMatch(/\bon\b/);
    expect(dlg.textContent).toMatch(/what every screen in Amlak already shows/);
  });

  // ⚠ On a cash basis the undated money must be REPORTED, never given an invented date
  // and never silently dropped. paid_date is nullable and deliberately un-backfilled.
  it('reports what a cash basis cannot date rather than dating it', async () => {
    const dlg = await openModal();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cash' }));
    await waitFor(() => {
      const flags = [...dlg.querySelectorAll('.cpa-flag')].map((f) => f.textContent).join(' ');
      // $6,000 undated Security + the $25,000 of taxes nobody itemized.
      expect(flags).toMatch(/\$31,000\.00 of expenses carry no payment date/);
    });
    const flags = [...dlg.querySelectorAll('.cpa-flag')].map((f) => f.textContent).join(' ');
    expect(flags).toMatch(/never given an invented date/);
    expect(flags).toMatch(/not in the totals/);
  });

  it('drops that warning again on accrual, where the year is what matters', async () => {
    const dlg = await openModal();
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cash' }));
    await waitFor(() => expect(dlg.textContent).toMatch(/no payment date/));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Accrual' }));
    await waitFor(() => expect(dlg.textContent).not.toMatch(/no payment date/));
  });
});
