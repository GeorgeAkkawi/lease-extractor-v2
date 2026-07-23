// Render test for the Financials/History property cards (against the demo mock): the
// Financials and History workspaces stop at the PROPERTY — there's no lease-level hover,
// because a lease page lives only in the Portfolio workspace and a lease link here would
// yank you out of Financials/History (George, 2026-07-23). So the card links to the
// property's Financials page and NO lease link is present. (Portfolio keeps its
// hover-to-lease fly-out — covered by propertiesFlyout.test.js.)
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import FinancialsPropertiesPage from '../FinancialsPropertiesPage';

function renderFinProps() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/financials/corp-1']}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes>
            <Route path="/financials/:corpId" element={<FinancialsPropertiesPage mode="financials" />} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

beforeEach(() => cleanup());

describe('FinancialsPropertiesPage — no lease-level hover', () => {
  it('cards link to the property Financials page, never to a lease', async () => {
    renderFinProps();
    await waitFor(() => expect(screen.getByText('Maple Plaza')).toBeTruthy());
    // The card is a link into the Financials workspace (stops at the property).
    await waitFor(() => expect(hrefs()).toContain('/financials/corp-1/prop-1'));
    // No lease-level links, and no "Go to a lease" fly-out header.
    expect(hrefs().some((h) => h && h.startsWith('/leases/'))).toBe(false);
    expect(screen.queryByText('Go to a lease')).toBeNull();
  });
});
