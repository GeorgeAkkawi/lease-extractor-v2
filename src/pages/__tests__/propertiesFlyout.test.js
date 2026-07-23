// Render smoke test for the property-card hover-to-lease fly-out (against the demo mock):
// mounts the REAL PropertiesPage and confirms each property card carries a fly-out with a
// direct link to every lease under it (targeting the lease detail page, which lives only
// in the Portfolio workspace, so always /leases/...). The links are in the DOM whether or
// not the CSS hover has revealed the panel, so we assert on their hrefs.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import PropertiesPage from '../PropertiesPage';

function renderProps() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/leases/corp-1']}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes>
            <Route path="/leases/:corpId" element={<PropertiesPage />} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const hrefs = () => Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

beforeEach(() => cleanup());

describe('PropertiesPage — hover-to-lease fly-out', () => {
  it('each property card links straight to its leases', async () => {
    renderProps();
    await waitFor(() => expect(screen.getByText('Maple Plaza')).toBeTruthy());
    // The fly-out lists each tenant with a direct link to its lease page.
    await waitFor(() => expect(hrefs()).toContain('/leases/corp-1/prop-1/lease-1'));
    expect(hrefs()).toContain('/leases/corp-1/prop-1/lease-2');
    expect(screen.getByText('Go to a lease')).toBeTruthy();
  });
});
