// The corporations landing grid is one shared component rendered in three modes.
// Its <h1> must match the tab it's under (the sidebar item + breadcrumb), not a
// blanket "Corporations". Mounted against the demo mock (DEMO mode forced by the
// test env). Standing in for the live-browser check when the shared browser is held.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import CorporationsPage from '../CorporationsPage';

function withProviders(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChromeProvider>
        <MemoryRouter>{ui}</MemoryRouter>
      </ChromeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => cleanup());

describe('CorporationsPage — heading matches the tab', () => {
  it('reads "Financials" on the financials tab', () => {
    withProviders(<CorporationsPage mode="financials" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Financials');
  });

  it('reads "History" on the history tab', () => {
    withProviders(<CorporationsPage mode="history" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('History');
  });

  it('reads "Portfolio" on the leases tab', () => {
    withProviders(<CorporationsPage mode="leases" />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portfolio');
  });
});
