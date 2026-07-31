// How a lease recovers its expenses is PICKED, not switched on (George, 2026-07-31:
// "it shouldnt say gross lease on or off it should just say gross/NNN and select the
// box"). An On/Off pair made NNN the unnamed absence of Gross — the same ambiguity the
// row chips exist to kill, reproduced on the control that sets the fact.
//
// Drives the REAL lease page against the demo mock: both states are named, the current
// one is selected, and picking Gross carries through to the estimate field (which a
// gross lease must not be able to fill, since nothing would ever bill it).
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseDetailPage from '../LeaseDetailPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { updateLease } from '../../lib/api';

const PATH = '/leases/corp-1/prop-1/lease-1';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

function renderLease() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[PATH]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/leases/:corpId/:propId/:leaseId" element={<LeaseDetailPage />} />
            </Routes>
          </ConfirmProvider>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const btn = (name) => screen.getByRole('button', { name });

beforeEach(() => cleanup());

describe('Lease page — the expense-recovery control', () => {
  it('names BOTH states and selects the one in force', async () => {
    renderLease();
    await waitFor(() => expect(screen.getByRole('button', { name: 'NNN' })).toBeTruthy());
    // Not "Gross lease: On/Off" — the two words the chips and the import review use.
    // Scoped to this control's own seg, because the roof toggle beside it is a genuine
    // On/Off (you switch a charge on; you don't switch a lease type on).
    const seg = btn('NNN').closest('.seg');
    expect([...seg.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['NNN', 'Gross']);
    expect(seg.closest('.field').textContent).not.toMatch(/Gross lease/);
    // lease_type is null in the seed, which the whole app reads as net — so NNN is the
    // one shown as chosen, never a pair of unselected buttons.
    expect(btn('NNN').className).toContain('on');
    expect(btn('Gross').className).not.toContain('on');
  });

  it('picking Gross carries through — the selection moves and the estimate field goes', async () => {
    renderLease();
    await waitFor(() => expect(screen.getByRole('button', { name: 'NNN' })).toBeTruthy());
    // Net: an estimate is a real input, because a net lease bills one all year.
    expect(document.querySelector('input[type=number][value="16500"]')
      || screen.getByText(/Est\. CAM & tax/)).toBeTruthy();

    fireEvent.click(btn('Gross'));
    await waitFor(() => expect(btn('Gross').className).toContain('on'));
    expect(btn('NNN').className).not.toContain('on');
    // The estimate becomes a statement rather than an input: on a gross lease there is
    // no figure to bill ahead of the actual, so a fillable box would write a number
    // nothing ever reads.
    await waitFor(() => expect(screen.getByText('Included in the rent')).toBeTruthy());

    // …and back, so the choice is genuinely two-way.
    fireEvent.click(btn('NNN'));
    await waitFor(() => expect(btn('NNN').className).toContain('on'));
    expect(screen.queryByText('Included in the rent')).toBeNull();
    await updateLease('lease-1', { lease_type: null });
  });
});
