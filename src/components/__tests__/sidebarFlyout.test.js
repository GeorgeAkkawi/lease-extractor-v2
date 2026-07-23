// Render smoke test for the sidebar hover fly-out: mounts the REAL Sidebar against the
// demo mock and confirms each workspace tab (Portfolio / Financials / History) renders a
// fly-out with a link straight to every corporation and its nested properties. useAuth is
// mocked so the corp query runs deterministically (no AuthProvider async).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';

vi.mock('../../context/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { id: 'demo', email: 'demo@amlak.com' } }),
}));

import Sidebar from '../Sidebar';

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Sidebar />
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

beforeEach(() => cleanup());

describe('Sidebar hover fly-out', () => {
  it('renders each corporation + its nested properties as direct links per workspace tab', async () => {
    renderSidebar();
    // The property links only exist once both the corp + corp-properties queries resolve.
    await waitFor(() => expect(hrefs()).toContain('/financials/corp-1/prop-1'));
    // Corp names show (one per fly-out: Portfolio / Financials / History).
    expect(screen.getAllByText('Acme Holdings').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Northwind Group').length).toBeGreaterThan(0);
    const links = hrefs();
    // Financials fly-out: straight to the corp AND its property (Maple Plaza under Acme).
    expect(links).toContain('/financials/corp-1');
    expect(links).toContain('/financials/corp-1/prop-1');
    // Portfolio fly-out uses the 'leases' mode; Oak Center sits under Northwind.
    expect(links).toContain('/leases/corp-2');
    expect(links).toContain('/leases/corp-2/prop-2');
    // History fly-out too.
    expect(links).toContain('/history/corp-1');
    // Third level: each property's tenants nested under it, ALWAYS linking to the lease
    // page (which lives only in the Portfolio workspace, so always /leases/...). Loads
    // once the batched sidebarLeases query resolves.
    await waitFor(() => expect(hrefs()).toContain('/leases/corp-1/prop-1/lease-1'));
    expect(hrefs()).toContain('/leases/corp-1/prop-1/lease-2');
  });
});
