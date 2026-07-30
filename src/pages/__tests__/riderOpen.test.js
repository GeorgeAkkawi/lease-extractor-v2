// Mounts the REAL LeaseDetailPage against the demo mock. George's ask, verbatim:
// "we have an open lease and right under make an open rider button (input the dates
// of the rider)."
//
// What only a render can prove: the rider rows actually reach the page, sit inside
// the lease-document panel, open the RIGHT rider's text, and that the saved-copies
// list is there beside them. The rider text has been fed to the AI assistant since
// 2026-07-01 — this is the first time a human can read it.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseDetailPage from '../LeaseDetailPage';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { ChromeProvider } from '../../context/ChromeContext';

// The demo seed puts two riders on City Dental (lease-2): an uploaded First Amendment
// that covers a real period, and a pasted Signage Rider with no file.
function mountLease(leaseId = 'lease-2') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/leases/corp-1/prop-1/${leaseId}`]}>
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

const riderRows = (container) => [...container.querySelectorAll('.rider-row')];

beforeEach(() => cleanup());

describe('Lease page — Open rider', () => {
  it('shows a row per rider, oldest first, each naming the period it covers', async () => {
    const { container } = mountLease();
    const rows = await waitFor(() => {
      const r = riderRows(container);
      expect(r.length).toBeGreaterThan(0);
      return r;
    });
    expect(rows).toHaveLength(2);
    // Oldest first — reading down the list walks the lease forward through time.
    expect(rows[0].textContent).toContain('First Amendment to Lease');
    expect(rows[1].textContent).toContain('Signage Rider');
    // The dates are the point of the row: a period, not just a signing date.
    expect(rows[0].querySelector('.rider-row-dates').textContent).toMatch(/→/);
    expect(rows[1].querySelector('.rider-row-dates').textContent).toMatch(/^· From /);
  });

  it('sits directly under "Open lease", inside the same panel', async () => {
    // George's placement, literally: "we have an open lease and right under make an
    // open rider button". A rider list somewhere else on the page is a different thing.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const panel = container.querySelector('.rider-rows').closest('.panel');
    expect(within(panel).getByRole('button', { name: /Open lease/i })).toBeTruthy();
    expect(within(panel).getAllByRole('button', { name: /Open rider/i })).toHaveLength(2);
  });

  it('opens THAT rider’s text — and closes it again', async () => {
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const rows = riderRows(container);

    // Nothing open to begin with (the lease's own document box is closed too).
    expect(container.querySelectorAll('.lease-doc')).toHaveLength(0);

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Open rider' }));
    await waitFor(() => expect(container.querySelector('.lease-doc')).toBeTruthy());
    expect(container.querySelector('.lease-doc').textContent).toContain('FIRST AMENDMENT TO LEASE');
    // …the first rider's text, not the second's.
    expect(container.querySelector('.lease-doc').textContent).not.toContain('SIGNAGE RIDER');

    // Clicking the OTHER rider switches the box rather than stacking a second one.
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Open rider' }));
    await waitFor(() => expect(container.querySelector('.lease-doc').textContent).toContain('SIGNAGE RIDER'));
    expect(container.querySelectorAll('.lease-doc')).toHaveLength(1);

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Hide rider' }));
    await waitFor(() => expect(container.querySelectorAll('.lease-doc')).toHaveLength(0));
  });

  it('offers "Open file" only for the rider that HAS one', async () => {
    // A pasted rider has cached text but no document — inventing a button for it would
    // promise a file that isn't there.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const rows = riderRows(container);
    expect(within(rows[0]).queryByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(rows[1]).queryByRole('button', { name: 'Open file' })).toBeNull();
  });

  it('lists every saved copy of the lease itself, newest first', async () => {
    // The registry (0070). City Dental is seeded with two copies, because a version
    // list only reads as history when something actually has two.
    const { container } = mountLease();
    const list = await waitFor(() => {
      const el = container.querySelector('.doc-list');
      expect(el).toBeTruthy();
      return el;
    });
    expect(list.textContent).toContain('Saved copies of the lease');
    const rows = [...list.querySelectorAll('.doc-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('city-dental-lease.pdf');
    // The older one says so, rather than looking like a duplicate.
    expect(rows[1].textContent).toContain('earlier copy');
    expect(rows[0].textContent).not.toContain('earlier copy');
    // Both are openable, and each can be removed individually.
    expect(within(list).getAllByRole('button', { name: 'Open' })).toHaveLength(2);
  });

  it('a lease with no riders shows no rider rows at all', async () => {
    // Bright Coffee (lease-1) has none — an empty "Open rider" heading would be noise.
    const { container } = mountLease('lease-1');
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Open lease/i }).length).toBeGreaterThan(0));
    expect(container.querySelector('.rider-rows')).toBeNull();
  });
});
