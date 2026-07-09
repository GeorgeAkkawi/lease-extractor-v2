// Render smoke test for the Leases page: the CAM+tax and Total-rent columns and the
// sort bar. Mounts the REAL page against the demo mock (DEMO mode forced by the test
// env) with the router + chrome providers it needs, so a render crash surfaces here.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import LeasesPage from '../LeasesPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChromeProvider>
        <MemoryRouter initialEntries={['/leases/corp-1/prop-1']}>
          <Routes>
            <Route path="/leases/:corpId/:propId" element={<LeasesPage />} />
          </Routes>
        </MemoryRouter>
      </ChromeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => cleanup());

describe('LeasesPage — CAM+tax / Total columns + sort bar', () => {
  it('renders both tenants with the new columns and the sort control', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Bright Coffee Co.')).toBeTruthy());
    expect(screen.getByText('City Dental')).toBeTruthy();
    // New columns (each row repeats the label) + the sort bar.
    expect(screen.getAllByText('CAM + tax').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Total rent').length).toBeGreaterThan(0);
    expect(screen.getByText('Sort by')).toBeTruthy();
    // The sort dropdown offers the documented modes.
    expect(screen.getByRole('option', { name: 'Total rent' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Address' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Custom order' })).toBeTruthy();
  });
});
