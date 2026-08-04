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
import { listAddendums, updateAddendum, deleteDocumentsFor } from '../../lib/api';

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

  it('sits directly under the lease’s own row, inside the same panel', async () => {
    // George's placement, literally: "we have an open lease and right under make an
    // open rider button". A rider list somewhere else on the page is a different thing.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const panel = container.querySelector('.rider-rows').closest('.panel');
    // Three "Read text" buttons: the lease's own, plus one per rider.
    expect(within(panel).getAllByRole('button', { name: 'Read text' })).toHaveLength(3);
  });

  it('opens THAT rider’s text — and closes it again', async () => {
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const rows = riderRows(container);

    // Nothing open to begin with (the lease's own document box is closed too).
    expect(container.querySelectorAll('.lease-doc')).toHaveLength(0);

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Read text' }));
    await waitFor(() => expect(container.querySelector('.lease-doc')).toBeTruthy());
    expect(container.querySelector('.lease-doc').textContent).toContain('FIRST AMENDMENT TO LEASE');
    // …the first rider's text, not the second's.
    expect(container.querySelector('.lease-doc').textContent).not.toContain('SIGNAGE RIDER');

    // Clicking the OTHER rider switches the box rather than stacking a second one.
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Read text' }));
    await waitFor(() => expect(container.querySelector('.lease-doc').textContent).toContain('SIGNAGE RIDER'));
    expect(container.querySelectorAll('.lease-doc')).toHaveLength(1);

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Hide text' }));
    await waitFor(() => expect(container.querySelectorAll('.lease-doc')).toHaveLength(0));
  });

  it('offers "Open file" where there is one and "Add a file" where there isn’t', async () => {
    // George, 2026-08-04: "for the riders, the only way to add a copy is to open it first,
    // look at the cached lease, and then add a copy. So the intuitiveness is a bit
    // difficult there." The add now lives on the ROW — no opening required — and a pasted
    // rider with no document says so by offering to take one, instead of a dead end.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const rows = riderRows(container);
    expect(within(rows[0]).queryByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(rows[0]).queryByRole('button', { name: 'Add a file' })).toBeNull();
    // The pasted Signage Rider: the other way round, and reachable with nothing opened.
    expect(within(rows[1]).queryByRole('button', { name: 'Open file' })).toBeNull();
    expect(within(rows[1]).queryByRole('button', { name: 'Add a file' })).toBeTruthy();
    expect(container.querySelectorAll('.lease-doc')).toHaveLength(0);
  });

  it('attaching a file to a rider flips its row to "Open file"', async () => {
    // The write that makes it stick is updateAddendum(storage_path) — the row reads that
    // column, not the document registry, so registering the upload alone would leave the
    // button saying "Add a file" until a reload.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const input = container.querySelector('.rider-group input[type="file"]');
    expect(input).toBeTruthy();
    const pasted = (await listAddendums('lease-2')).find((a) => !a.storage_path);
    expect(pasted).toBeTruthy();

    fireEvent.click(within(riderRows(container)[1]).getByRole('button', { name: 'Add a file' }));
    fireEvent.change(input, {
      target: { files: [new File(['signed'], 'signage-rider.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() =>
      expect(within(riderRows(container)[1]).queryByRole('button', { name: 'Open file' })).toBeTruthy()
    );
    expect(within(riderRows(container)[1]).queryByRole('button', { name: 'Add a file' })).toBeNull();
    // The rider beside it is untouched.
    expect(within(riderRows(container)[0]).queryByRole('button', { name: 'Open file' })).toBeTruthy();

    // Put the seed back — the demo store is module-level and shared, so leaving this
    // rider with a file would silently change what the tests below are looking at.
    await deleteDocumentsFor('addendum', pasted.id);
    await updateAddendum(pasted.id, { storage_path: null });
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
    expect(within(list).getAllByRole('button', { name: 'Open file' })).toHaveLength(2);
  });

  it('drops the add control once a file is on file — and offers it when none is', async () => {
    // George, 2026-08-04: "If there is a hard copy of a lease saved take out the add a copy
    // button, that should only be there when there's none saved… it says a saved copy of the
    // lease and then add a copy even though right under there already is a copy."
    //
    // It costs no version history, by his own reasoning: a lease's next version arrives as an
    // ADDENDUM (AI-read on its way in), never as another "copy" of the same document.
    const { container } = mountLease(); // City Dental — two copies on file
    // Scoped to the LEASE's list: the insurance panel further down the page mounts one too.
    const list = await waitFor(() => {
      const el = container.querySelector('.doc-list');
      expect(el?.querySelectorAll('.doc-row').length).toBe(2);
      return el;
    });
    expect(within(list).queryByRole('button', { name: /Add a file/i })).toBeNull();

    // Bright Coffee has nothing on file — there the invitation is exactly right.
    cleanup();
    const bare = mountLease('lease-1');
    const emptyList = await waitFor(() => {
      const el = bare.container.querySelector('.doc-list');
      expect(el.textContent).toContain('No file on file');
      return el;
    });
    expect(within(emptyList).getByRole('button', { name: /Add a file/i })).toBeTruthy();
  });

  it('every action on the panel is the same kind of button', async () => {
    // George, 2026-08-04: "make the open lease and open rider buttons the same formatting,
    // they look different." They were: the lease's was the only full-size .ghost, which the
    // base button rule renders UPPERCASE at 11.5px, beside sentence-case 11px rider buttons.
    // Everything on this panel is now .ghost.btn-sm, so the row you're looking at doesn't
    // change what a button looks like.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const panel = container.querySelector('.rider-group').closest('.doc-panel');
    // The named actions only — a copy's ✕ is an .icon-btn and deliberately looks nothing
    // like them.
    const actions = [...panel.querySelectorAll('.doc-actions button:not(.icon-btn)')];
    expect(actions.length).toBeGreaterThanOrEqual(5);
    actions.forEach((b) => {
      expect(b.classList.contains('ghost')).toBe(true);
      expect(b.classList.contains('btn-sm')).toBe(true);
    });
  });

  it('stacks the saved copies, then "Open lease", then the riders', async () => {
    // George, 2026-08-04: "I want the open lease button to be above the rider's button.
    // So the order should go the saved copy of the lease, then open lease, then open
    // riders." That puts "Open lease" DIRECTLY on top of "Open rider" — the adjacency of
    // his original ask (2026-07-30, "we have an open lease and right under make an open
    // rider button"), which the copies list had grown in between.
    //
    // Asserted on the real page rather than on DocAssistant alone, because the order is
    // produced by WHICH SLOT each list is passed to — a page that passed both to the same
    // slot would still render, just in the wrong order.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));

    // Scoped to the LEASE's assistant: the page also mounts one per insurance policy and
    // per service contract, each its own .doc-panel with its own Open row.
    const panel = container.querySelector('.rider-group').closest('.doc-panel');
    const marks = [...panel.querySelectorAll(':scope > .doc-list, :scope > .doc-open-row, :scope > .rider-group')]
      .map((el) => (el.classList.contains('doc-list') ? 'copies' : el.classList.contains('doc-open-row') ? 'open-lease' : 'riders'));
    expect(marks).toEqual(['copies', 'open-lease', 'riders']);

    // …and it really is the lease's own button in that middle block, not just a div.
    const openRow = panel.querySelector(':scope > .doc-open-row');
    expect(within(openRow).getByRole('button', { name: 'Read text' })).toBeTruthy();
    expect(openRow.textContent).toContain('A copy of this lease is saved.');
  });

  it('gives every primary action the same trailing column, so they line up', async () => {
    // George, 2026-07-30: "the open lease button should be in line with the lease open
    // button." Alignment itself is CSS (a fixed .doc-act2 column, measured in the
    // browser); what a render can pin is the structure that produces it — each primary
    // action sits in a .doc-actions group whose LAST child is that reserved slot, whether
    // or not the row has a second control to put in it.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));

    const groups = [...container.querySelectorAll('.doc-panel .doc-actions')];
    // The lease's own Read text, its two copy rows, and the two riders. (No ⬆ Add — this
    // lease has files on it, so the add control is gone.)
    expect(groups.length).toBeGreaterThanOrEqual(5);
    groups.forEach((g) => {
      expect(g.lastElementChild?.classList.contains('doc-act2')).toBe(true);
    });

    // …including the lease row's, which reserves an EMPTY one so its button ends where
    // the rows' buttons do rather than sitting flush against the panel edge.
    const readLease = within(container.querySelector('.doc-open-row')).getByRole('button', { name: 'Read text' });
    const headGroup = readLease.closest('.doc-actions');
    expect(headGroup).toBeTruthy();
    expect(headGroup.querySelector('.doc-act2').childElementCount).toBe(0);

    // Both riders fill that slot now — one with its file, one with the offer of one.
    const rows = riderRows(container);
    expect(within(rows[0].querySelector('.doc-act2')).getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(rows[1].querySelector('.doc-act2')).getByRole('button', { name: 'Add a file' })).toBeTruthy();
  });

  it('a lease with no riders shows no rider rows at all', async () => {
    // Bright Coffee (lease-1) has none — an empty "Open rider" heading would be noise.
    const { container } = mountLease('lease-1');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Read text' }).length).toBeGreaterThan(0));
    expect(container.querySelector('.rider-rows')).toBeNull();
  });
});
