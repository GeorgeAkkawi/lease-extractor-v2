// The Rent escalations section folds shut (George, 2026-07-29: "add a collapse button for
// rent escalations"). Drives the REAL lease page against the demo mock.
//
// Two things are load-bearing beyond "the table hides": collapsed, the head still states
// what the section holds — a fold that hides its own summary just makes you open it again
// — and a deep-link from an alert forces it open, so the scroll-and-flash can never land
// on a closed panel.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseDetailPage from '../LeaseDetailPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';

// lease-1 (Bright Coffee) carries one upcoming escalation in the demo seed (esc-1), so
// the collapsed summary has a next step to name.
const PATH = '/leases/corp-1/prop-1/lease-1';

// jsdom has no layout, so scrollIntoView doesn't exist — and the ?focus= deep-link calls
// it. Stub it rather than guarding the page for a test's benefit.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

function renderLease(path = PATH) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
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

const toggle = () => screen.getByRole('button', { name: /Rent escalations/ });

beforeEach(() => cleanup());

describe('Lease page — Rent escalations collapses', () => {
  it('opens expanded, folds away on click, and comes back', async () => {
    renderLease();
    await waitFor(() => expect(toggle()).toBeTruthy());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    // The editor's own add-a-step form proves the section is really rendered.
    expect(screen.getByRole('button', { name: /Add escalation/ })).toBeTruthy();

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.queryByRole('button', { name: /Add escalation/ })).toBeNull());

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(screen.getByRole('button', { name: /Add escalation/ })).toBeTruthy());
  });

  it('still says what it holds while shut — the step count, not a bare title', async () => {
    renderLease();
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(/\d+ steps?/)).toBeTruthy());
  });

  it('is forced open when an alert deep-links to it', async () => {
    // ?focus=escalation is what the Overview's escalation reminder navigates to; landing
    // on a folded panel would flash an empty box.
    renderLease(`${PATH}?focus=escalation`);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle()); // shut it…
    expect(toggle().getAttribute('aria-expanded')).toBe('false');

    cleanup();
    renderLease(`${PATH}?focus=escalation`);
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByRole('button', { name: /Add escalation/ })).toBeTruthy();
  });
});
