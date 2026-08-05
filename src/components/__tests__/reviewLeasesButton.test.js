// The property-wide "⚑ Review leases" sweep, at the two moments a landlord meets it:
// the dialog that asks for the money, and the report that comes back.
//
// Both were wrong in ways the demo could not show. The dialog quoted a price derived from
// `lease.lease_text`, a column listLeases deliberately does NOT select — so live it read
// every lease as "needs transcribing" and quoted seven times the truth, while the demo
// quoted it correctly because mockClient's builder ignores column lists. And the report
// was a single portfolio total, which named no lease and linked nowhere.
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  reviewLeases: vi.fn(),
}));

const { reviewLeases } = await import('../../lib/api');
const { default: ReviewLeasesButton, ReviewResults } = await import('../ReviewLeasesButton');
const { ConfirmProvider } = await import('../ConfirmDialog');

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

// The page owns the report, exactly as LeasesPage does — the button hands its results up
// so the panel can render full-width under the head instead of inside the button row.
function Harness({ leases }) {
  const [results, setResults] = useState(null);
  return (
    <>
      <ReviewLeasesButton leases={leases} onResults={setResults} />
      <ReviewResults results={results} corpId="c1" propId="p1" />
      <Where />
    </>
  );
}

function renderButton(leases) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/leases/c1/p1']}>
      <QueryClientProvider client={qc}>
        <ConfirmProvider>
          <Routes>
            <Route path="*" element={<Harness leases={leases} />} />
          </Routes>
        </ConfirmProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const openDialog = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Review leases/i }));
  return screen.findByRole('alertdialog');
};

beforeEach(() => {
  cleanup();
  reviewLeases.mockReset();
});

describe('the dialog that asks for the money', () => {
  // THE REGRESSION. These rows are what listLeases actually returns — LEASE_LIST_COLS has
  // no lease_text — so a price that reads it is a price computed from `undefined`.
  it('quotes the same figure whether or not the row carries lease_text', async () => {
    const withText = [{ id: 'a', tenant_name: 'Alpha', lease_text: 'x'.repeat(4000) }];
    const withoutText = [{ id: 'a', tenant_name: 'Alpha' }];

    renderButton(withText);
    let dialog = await openDialog();
    const quotedWithText = within(dialog).getByText(/will be reviewed/i).textContent;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    cleanup();

    renderButton(withoutText);
    dialog = await openDialog();
    const quotedWithoutText = within(dialog).getByText(/will be reviewed/i).textContent;

    expect(quotedWithoutText).toBe(quotedWithText);
    expect(quotedWithoutText).toMatch(/about 4¢/i);   // 1 lease × 4¢, not 29¢
  });

  it('describes the transcription cost instead of pretending to count it', async () => {
    renderButton([{ id: 'a', tenant_name: 'Alpha' }, { id: 'b', tenant_name: 'Beta' }]);
    const dialog = await openDialog();
    expect(within(dialog).getByText(/about 8¢ in total/i)).toBeTruthy();
    expect(within(dialog).getByText(/transcribed first/i)).toBeTruthy();
    // The old copy asserted a number it could not know.
    expect(within(dialog).queryByText(/have no searchable text yet/i)).toBeNull();
  });

  it('is not styled as a destructive action — it is a paid read', async () => {
    renderButton([{ id: 'a', tenant_name: 'Alpha' }]);
    const dialog = await openDialog();
    expect(dialog.querySelector('.danger-solid')).toBeNull();
  });

  it('runs nothing when the landlord cancels', async () => {
    renderButton([{ id: 'a', tenant_name: 'Alpha' }]);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(reviewLeases).not.toHaveBeenCalled();
  });
});

describe('the report that comes back', () => {
  const confirmSweep = async () => {
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review leases' }));
  };

  it('names every lease, ranks the worst first, and links to the one to open', async () => {
    reviewLeases.mockResolvedValue([
      { id: 'a', tenant_name: 'Alpha', ok: true, cached: false, flags: 2, high: 0 },
      { id: 'b', tenant_name: 'Beta', ok: true, cached: false, flags: 5, high: 3 },
      { id: 'c', tenant_name: 'Gamma', ok: true, cached: false, flags: 0, high: 0 },
    ]);
    const { container } = renderButton([
      { id: 'a', tenant_name: 'Alpha' }, { id: 'b', tenant_name: 'Beta' }, { id: 'c', tenant_name: 'Gamma' },
    ]);
    await confirmSweep();

    await waitFor(() => expect(screen.getByText(/7 found in the documents/i)).toBeTruthy());
    const rows = [...container.querySelectorAll('.review-result-row')];
    expect(rows.map((r) => r.querySelector('.rvw-tenant').textContent)).toEqual(['Beta', 'Alpha', 'Gamma']);
    // A lease that came back clean is still accounted for — not silently dropped.
    expect(within(rows[2]).getByText('nothing found')).toBeTruthy();
    expect(within(rows[0]).getByText(/3 high · 5 found/i)).toBeTruthy();

    fireEvent.click(rows[0]);
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/leases/c1/p1/b'));
  });

  it('still names the lease that failed, and why', async () => {
    reviewLeases.mockResolvedValue([
      { id: 'a', tenant_name: 'Alpha', ok: true, cached: false, flags: 1, high: 0 },
      { id: 'b', tenant_name: 'Beta', ok: false, cached: false, error: 'No document is on file.' },
    ]);
    renderButton([{ id: 'a', tenant_name: 'Alpha' }, { id: 'b', tenant_name: 'Beta' }]);
    await confirmSweep();

    await waitFor(() => expect(screen.getByText(/Reviewed 1 of 2 leases/i)).toBeTruthy());
    expect(screen.getByText(/⚠ Beta/)).toBeTruthy();
    expect(screen.getByText('No document is on file.')).toBeTruthy();
  });
});
