// The property-wide "⚑ Review leases" sweep, at the two moments a landlord meets it: the
// dialog that asks, and the report that comes back.
//
// The dialog QUOTES NO PRICE (George: "take out how much it costs, the user doesn't care
// about that"). It used to, and the figure was wrong on every live click: it was derived
// from `lease.lease_text`, a column listLeases deliberately does NOT select, so every lease
// read as "needs transcribing" and the quote came out seven times the truth. It looked right
// in the demo only because mockClient's builder ignores column lists. The invariant kept
// below is the one that outlives the price — NOTHING the dialog says may depend on a column
// the list query doesn't fetch.
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  reviewLeases: vi.fn(),
}));

const { reviewLeases } = await import('../../lib/api');
const { default: ReviewLeasesButton, ReviewResults } = await import('../ReviewLeasesButton');
const { ConfirmProvider } = await import('../ConfirmDialog');

// The page owns the report, exactly as LeasesPage does — the button hands its results up
// so the panel can render full-width under the head instead of inside the button row.
function Harness({ leases }) {
  const [results, setResults] = useState(null);
  const [progress, setProgress] = useState(null);
  return (
    <>
      <ReviewLeasesButton leases={leases} onResults={setResults} onProgress={setProgress} />
      <ReviewResults results={results} progress={progress} onDismiss={() => setResults(null)} />
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

describe('the dialog that asks', () => {
  // THE REGRESSION. These rows are what listLeases actually returns — LEASE_LIST_COLS has
  // no lease_text — so anything the dialog derives from it is derived from `undefined`.
  it('says exactly the same thing whether or not the row carries lease_text', async () => {
    const withText = [{ id: 'a', tenant_name: 'Alpha', lease_text: 'x'.repeat(4000) }];
    const withoutText = [{ id: 'a', tenant_name: 'Alpha' }];

    renderButton(withText);
    let dialog = await openDialog();
    const saidWithText = dialog.querySelector('.confirm-imp').textContent;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    cleanup();

    renderButton(withoutText);
    dialog = await openDialog();
    const saidWithoutText = dialog.querySelector('.confirm-imp').textContent;

    expect(saidWithoutText).toBe(saidWithText);
  });

  it('states no price at all', async () => {
    renderButton([{ id: 'a', tenant_name: 'Alpha' }, { id: 'b', tenant_name: 'Beta' }]);
    const dialog = await openDialog();
    // No figure, in any currency. ("terms that commonly cost a landlord money" is the
    // point of the feature, not a price, and stays.)
    expect(dialog.textContent).not.toMatch(/¢|\$\s?\d|\d+\s*cents/i);
    // It still says what the action does, including the transcription step.
    expect(within(dialog).getByText(/Every tenant on this property is read/i)).toBeTruthy();
    expect(within(dialog).getByText(/transcribed first/i)).toBeTruthy();
    // The old copy asserted a count it could not know.
    expect(within(dialog).queryByText(/have no searchable text yet/i)).toBeNull();
  });

  it('is not styled as a destructive action — it is a read', async () => {
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

  it('reports the run in one line, and can be dismissed', async () => {
    reviewLeases.mockResolvedValue([
      { id: 'a', tenant_name: 'Alpha', ok: true, cached: false, flags: 2, high: 0 },
      { id: 'b', tenant_name: 'Beta', ok: true, cached: false, flags: 5, high: 3 },
      { id: 'c', tenant_name: 'Gamma', ok: true, cached: false, flags: 0, high: 0 },
    ]);
    const { container } = renderButton([
      { id: 'a', tenant_name: 'Alpha' }, { id: 'b', tenant_name: 'Beta' }, { id: 'c', tenant_name: 'Gamma' },
    ]);
    await confirmSweep();

    await waitFor(() => expect(screen.getByText(/Reviewed 3 of 3 leases · 7 found in the documents/i)).toBeTruthy());
    // Deliberately NOT a roll-call of tenants — the durable per-lease signal is the flag
    // badge on the tenant row, and saying it twice made this a wall of names.
    expect(container.querySelectorAll('.review-result-row').length).toBe(0);
    expect(screen.queryByText('Alpha')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Reviewed 3 of 3/i)).toBeNull());
  });

  it('still names the lease that failed, and why', async () => {
    reviewLeases.mockResolvedValue([
      { id: 'a', tenant_name: 'Alpha', ok: true, cached: false, flags: 1, high: 0 },
      { id: 'b', tenant_name: 'Beta', ok: false, cached: false, error: 'No document is on file.' },
    ]);
    renderButton([{ id: 'a', tenant_name: 'Alpha' }, { id: 'b', tenant_name: 'Beta' }]);
    await confirmSweep();

    await waitFor(() => expect(screen.getByText(/Reviewed 1 of 2 leases/i)).toBeTruthy());
    // "Reviewed 1 of 2" without naming the one that didn't is the one shape of this panel
    // that leaves the landlord unable to act.
    expect(screen.getByText(/⚠ Beta/)).toBeTruthy();
    expect(screen.getByText('No document is on file.')).toBeTruthy();
  });
});
