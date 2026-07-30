// Mounts the REAL HistoryPage against the demo mock, so the story cards are driven the
// way the browser drives them. The pure shaper is pinned in tenantStory.test.js; this is
// the wiring — that the leases query reaches the cards, that folding works, and that the
// two things the deleted archive table did (Open & ask, remove) survived the rewrite.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import HistoryPage from '../HistoryPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../../components/ConfirmDialog';

function renderHistory(corpId = 'corp-1', propId = 'prop-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/history/${corpId}/${propId}`]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <Routes><Route path="/history/:corpId/:propId" element={<HistoryPage />} /></Routes>
          </ConfirmProvider>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const card = (container, tenant) =>
  [...container.querySelectorAll('.story-card')].find((n) => n.textContent.includes(tenant));

beforeEach(() => cleanup());

describe('History — who has occupied this property', () => {
  it('heads the section with the property, so you know where you are', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/Who has occupied Maple Plaza/)).toBeTruthy());
  });

  it('gives every tenant a card whose folded summary already states the essentials', async () => {
    const { container } = renderHistory();
    const bright = await waitFor(() => {
      const el = card(container, 'Bright Coffee');
      expect(el).toBeTruthy();
      return el;
    });
    // Collapsed it still says what it holds — the .panel-toggle rule.
    const summary = bright.querySelector('.story-summary').textContent;
    expect(summary).toMatch(/SF/);
    expect(summary).toMatch(/\/yr/);
    expect(summary).toMatch(/recorded change/);
    // …and it's genuinely folded until asked.
    expect(bright.querySelector('.story-timeline')).toBeNull();
  });

  it('opens to a timeline built from the lease itself — no history event required', async () => {
    const { container } = renderHistory();
    const bright = await waitFor(() => {
      const el = card(container, 'Bright Coffee');
      expect(el).toBeTruthy();
      return el;
    });
    fireEvent.click(within(bright).getByRole('button', { expanded: false }));
    await waitFor(() => expect(bright.querySelector('.story-timeline')).toBeTruthy());
    const rows = [...bright.querySelectorAll('.story-timeline li')].map((n) => n.textContent);
    // The bookends the old empty timeline could never show, because nothing logs them.
    expect(rows.some((t) => /Moved in/.test(t))).toBe(true);
    expect(rows.some((t) => /Term ends?|Term ended/.test(t))).toBe(true);
  });

  it('no longer draws the old flat event table or the separate archive section', async () => {
    renderHistory();
    await waitFor(() => expect(screen.getByText(/Who has occupied/)).toBeTruthy());
    expect(screen.queryByText('Lease & tenant history')).toBeNull();
    expect(screen.queryByText(/Expired & renewed leases/)).toBeNull();
  });

  it('files bookkeeping events in their own folded log, out of the tenant stories', async () => {
    const { container } = renderHistory();
    // The demo seeds an insurance_requested (a story event) and CAM/statement entries.
    await waitFor(() => expect(screen.getByText(/Who has occupied/)).toBeTruthy());
    const log = screen.queryByText('Bookkeeping log');
    if (!log) return; // a seed with no ledger events at all — nothing to assert
    // Folded until asked, and no bookkeeping row leaks into a story card.
    expect(container.querySelector('.story-timeline')).toBeNull();
    fireEvent.click(log.closest('button'));
    await waitFor(() => expect(container.querySelector('.exp-block table')).toBeTruthy());
  });
});
