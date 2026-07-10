// Render smoke tests for the annual-report feature, mounted against the demo mock
// (DEMO mode forced by the test env). Covers (1) the new "Annual report" button on
// every corporation card next to "Business profile", and (2) the AnnualReportModal
// reading the seeded record (Acme Holdings, ar-1) — the deadline line + Mark-filed
// action. Standing in for the live-browser click-through when the shared browser is held.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import CorporationsPage from '../CorporationsPage';
import AnnualReportModal from '../../components/AnnualReportModal';

function withProviders(ui, initial = '/leases') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChromeProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/leases" element={ui} />
            <Route path="/leases/:corpId" element={<div>corp landing</div>} />
          </Routes>
        </MemoryRouter>
      </ChromeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => cleanup());

describe('CorporationsPage — Annual report button', () => {
  it('shows an "Annual report" action alongside "Business profile" on every card', async () => {
    withProviders(<CorporationsPage mode="leases" />);
    await waitFor(() => expect(screen.getByText('Acme Holdings')).toBeTruthy());
    expect(screen.getByText('Northwind Group')).toBeTruthy();
    // One per corporation card (2 seeded corps).
    expect(screen.getAllByText('Annual report').length).toBe(2);
    expect(screen.getAllByText('Business profile').length).toBe(2);
  });
});

describe('AnnualReportModal — reads the seeded record', () => {
  it('renders the deadline line and the Mark-filed action for a corp with a due date', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AnnualReportModal corp={{ id: 'corp-1', name: 'Acme Holdings' }} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    // Heading + explainer render immediately.
    expect(screen.getByText('Acme Holdings — annual report')).toBeTruthy();
    // Once the seeded ar-1 (due_date set) loads, the deadline line + Mark filed appear.
    await waitFor(() => expect(screen.getByText(/Files every year by/)).toBeTruthy());
    expect(screen.getByText('✓ Mark filed')).toBeTruthy();
    expect(screen.getByText('Filing due date')).toBeTruthy();
  });

  it('shows the empty state for a corp with no record on file', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AnnualReportModal corp={{ id: 'corp-2', name: 'Northwind Group' }} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText('No filing date on file yet.')).toBeTruthy());
    // No due date yet → the Save-side hint replaces the Mark-filed button.
    expect(screen.queryByText('✓ Mark filed')).toBeNull();
  });
});
