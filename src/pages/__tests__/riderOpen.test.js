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
import {
  listAddendums, updateAddendum, deleteDocumentsFor,
  getLease, updateLease, listDocuments, registerDocument,
} from '../../lib/api';

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

// The LEASE block is the same shape as the riders' (that is the point — George,
// 2026-08-04), so it uses .rider-group too. .lease-group is what tells them apart.
const riderRows = (c) => [...c.querySelectorAll('.rider-group:not(.lease-group) .rider-row')];
const leaseRows = (c) => [...c.querySelectorAll('.lease-group .rider-row')];

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
    const input = container.querySelector('.rider-group:not(.lease-group) input[type="file"]');
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

  it('renders the lease as ONE rider-shaped row: name, Read text, the file action', async () => {
    // George, 2026-08-04: "now follow the same format as the riders. Lease - read text -
    // add/open file whichever is there." The "Saved copies of the lease" list and the
    // assistant's separate status row were two blocks describing one document two ways.
    const { container } = mountLease();
    await waitFor(() => expect(leaseRows(container).length).toBeGreaterThan(0));
    const head = container.querySelector('.lease-group .rider-head');
    expect(head.textContent).toBe('Lease');
    // Gone: no titled copies list on this panel at all.
    expect(container.querySelector('.doc-panel .doc-list')).toBeNull();

    const row = leaseRows(container)[0];
    // Named and dated exactly like a rider row — same formatter, so they can't drift.
    expect(row.textContent).toContain('Lease');
    expect(row.querySelector('.rider-row-dates').textContent).toMatch(/→/);
    expect(within(row).getByRole('button', { name: 'Read text' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Open file' })).toBeTruthy();
    // …and it opens the lease's own text, into the same box a rider opens into.
    fireEvent.click(within(row).getByRole('button', { name: 'Read text' }));
    await waitFor(() => expect(container.querySelector('.lease-group .lease-doc')).toBeTruthy());
    expect(container.querySelector('.lease-group .lease-doc').textContent).not.toContain('SIGNAGE RIDER');
  });

  it('keeps an older copy reachable, as a plain extra row', async () => {
    // City Dental is seeded with two files — accounts predate the one-document rule, and a
    // file that exists must stay openable. It sits UNDER the lease as an extra row with its
    // own ✕, not as a titled list competing with the lease itself.
    const { container } = mountLease();
    await waitFor(() => expect(leaseRows(container).length).toBe(2));
    const [main, older] = leaseRows(container);
    expect(main.textContent).not.toContain('Earlier copy');
    expect(older.textContent).toContain('Earlier copy');
    expect(older.textContent).toContain('city-dental-lease.pdf');
    expect(within(older).getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(older.querySelector('.icon-btn')).toBeTruthy();
    // An older copy has no text of its own — there is one cached transcription.
    expect(within(older).queryByRole('button', { name: 'Read text' })).toBeNull();
  });

  it('offers "Add a file" on the lease row when nothing is on file', async () => {
    // George, 2026-08-04: "add/open file whichever is there" — and, earlier the same day,
    // "if there is a copy, you shouldn't have an add a copy button". One slot, one state.
    // Bright Coffee has no document; City Dental has one and shows Open file instead
    // (asserted above).
    const { container } = mountLease('lease-1');
    await waitFor(() => expect(leaseRows(container).length).toBe(1));
    const row = leaseRows(container)[0];
    await waitFor(() => expect(within(row).queryByRole('button', { name: 'Add a file' })).toBeTruthy());
    expect(within(row).queryByRole('button', { name: 'Open file' })).toBeNull();
    // Bright Coffee's text was pasted, not extracted from a file — so the ✕ offers to
    // delete the TEXT. Without this the whole block had no remove button at all.
    expect(row.querySelector('.doc-act3 .icon-btn').title).toBe('Delete the saved text');
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

  it('stacks LEASE then RIDERS, two blocks of the same shape', async () => {
    // George's order from earlier the same day — the lease leads, the riders follow — now
    // that both are the same kind of block. The assistant's own status row is gone from
    // this panel entirely (hideOwnRow): it described the lease a second, different way.
    //
    // Asserted on the real page rather than on DocAssistant alone, because the order is
    // produced by WHICH SLOT each block is passed to — a page that passed both to the same
    // slot would still render, just in the wrong order.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));

    // Scoped to the LEASE's assistant: the page also mounts one per insurance policy and
    // per service contract, each its own .doc-panel.
    const panel = container.querySelector('.lease-group').closest('.doc-panel');
    const marks = [...panel.querySelectorAll(':scope > .rider-group, :scope > .doc-open-row, :scope > .doc-list')]
      .map((el) => (el.classList.contains('lease-group') ? 'lease' : el.classList.contains('rider-group') ? 'riders' : 'other'));
    expect(marks).toEqual(['lease', 'riders']);
    // Both blocks announce themselves the same way.
    expect([...panel.querySelectorAll('.rider-head')].map((h) => h.textContent)).toEqual(['Lease', 'Riders']);
  });

  it('gives every row the same three action columns, so they line up', async () => {
    // George, 2026-07-30: "the open lease button should be in line with the lease open
    // button." Alignment itself is CSS (fixed .doc-act2 / .doc-act3 columns, measured in
    // the browser); what a render can pin is the structure that produces it — every row's
    // .doc-actions group ends in the same two reserved slots, whether or not that row has
    // anything to put in them.
    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));

    const panel = container.querySelector('.lease-group').closest('.doc-panel');
    const groups = [...panel.querySelectorAll('.doc-actions')];
    // The lease row, its one older copy, and the two riders.
    expect(groups.length).toBe(4);
    groups.forEach((g) => {
      expect(g.lastElementChild?.classList.contains('doc-act3')).toBe(true);
      expect(g.lastElementChild.previousElementSibling?.classList.contains('doc-act2')).toBe(true);
    });

    // The FILE column holds a file action on every row — including the older copy, whose
    // "Read text" slot is simply empty rather than pushing its Open file left.
    const [leaseMain, leaseOlder] = leaseRows(container);
    expect(within(leaseMain.querySelector('.doc-act2')).getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(leaseOlder.querySelector('.doc-act2')).getByRole('button', { name: 'Open file' })).toBeTruthy();
    const rows = riderRows(container);
    expect(within(rows[0].querySelector('.doc-act2')).getByRole('button', { name: 'Open file' })).toBeTruthy();
    expect(within(rows[1].querySelector('.doc-act2')).getByRole('button', { name: 'Add a file' })).toBeTruthy();

    // The DELETE column holds a ✕ on every row that is holding SOMETHING — including the
    // pasted Signage Rider, whose only content is text (George, 2026-08-04: "add it to the
    // riders as well"). The title says which of the two that row would delete.
    expect(leaseMain.querySelector('.doc-act3 .icon-btn').title).toBe('Delete this file');
    expect(leaseOlder.querySelector('.doc-act3 .icon-btn').title).toBe('Delete this copy');
    expect(rows[0].querySelector('.doc-act3 .icon-btn').title).toBe('Delete this file');
    expect(rows[1].querySelector('.doc-act3 .icon-btn').title).toBe('Delete the saved text');
  });

  it('a lease with no riders shows the LEASE block and no riders block', async () => {
    // Bright Coffee (lease-1) has none — an empty "Riders" heading would be noise. The
    // lease's own block still stands on its own.
    const { container } = mountLease('lease-1');
    await waitFor(() => expect(leaseRows(container).length).toBe(1));
    expect(container.querySelector('.rider-group:not(.lease-group)')).toBeNull();
  });

  // ---- Deleting a file (these two MUTATE the shared demo store, so they run last and
  //      each puts the seed back) -------------------------------------------------------
  //
  // George, 2026-08-04: *"there should be a remove button which pops up and says delete
  // file (deleting this file will also cause the saved text to delete as well — make sure
  // this is true)"*. The dialog says it; these prove it isn't a bluff.

  it('deletes the lease’s file AND its saved text, exactly as the dialog warns', async () => {
    const before = await getLease('lease-2');
    const [newestBefore] = await listDocuments('lease', 'lease-2');
    expect(before.lease_text).toBeTruthy();
    expect(newestBefore).toBeTruthy();

    const { container } = mountLease();
    await waitFor(() => expect(leaseRows(container).length).toBe(2));
    fireEvent.click(within(leaseRows(container)[0]).getByTitle('Delete this file'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('aria-label')).toBe('Delete this file?');
    expect(dialog.textContent).toMatch(/saved text goes with it/i);
    // …and it is honest about what does NOT go — the figures the AI already wrote in.
    expect(dialog.textContent).toMatch(/rent, dates, square footage and terms/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    // The cached transcription is gone from the lease itself, not just from the screen.
    await waitFor(async () => expect((await getLease('lease-2')).lease_text).toBeFalsy());
    expect(await listDocuments('lease', 'lease-2')).toHaveLength(1);

    // The row stops offering text to read, and the panel offers the way back: paste it in.
    await waitFor(() =>
      expect(within(container.querySelector('.lease-group')).queryByRole('button', { name: 'Read text' })).toBeNull()
    );
    expect(container.querySelector('.doc-panel textarea')).toBeTruthy();
    // The earlier copy is untouched and simply becomes the lease's file.
    expect(leaseRows(container)).toHaveLength(1);

    await updateLease('lease-2', { lease_text: before.lease_text });
    await registerDocument({
      entityType: 'lease', entityId: 'lease-2', storagePath: newestBefore.storage_path,
      filename: newestBefore.filename, bytes: newestBefore.bytes, mime: newestBefore.mime,
    });
  });

  it('deletes a rider’s file and text together, and leaves the rider standing', async () => {
    const [riderBefore] = await listAddendums('lease-2');
    expect(riderBefore.storage_path).toBeTruthy();
    expect(riderBefore.addendum_text).toBeTruthy();

    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    fireEvent.click(within(riderRows(container)[0]).getByTitle('Delete this file'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(/saved text goes with it/i);
    expect(dialog.textContent).toMatch(/rider itself stays/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    // Still two riders — only the document left.
    await waitFor(() =>
      expect(within(riderRows(container)[0]).queryByRole('button', { name: 'Add a file' })).toBeTruthy()
    );
    expect(riderRows(container)).toHaveLength(2);
    expect(riderRows(container)[0].textContent).toContain('First Amendment to Lease');
    expect(within(riderRows(container)[0]).queryByRole('button', { name: 'Read text' })).toBeNull();
    const after = (await listAddendums('lease-2')).find((a) => a.id === riderBefore.id);
    expect(after.storage_path).toBeFalsy();
    expect(after.addendum_text).toBeFalsy();

    await updateAddendum(riderBefore.id, {
      storage_path: riderBefore.storage_path, addendum_text: riderBefore.addendum_text,
    });
    await registerDocument({
      entityType: 'addendum', entityId: riderBefore.id, storagePath: riderBefore.storage_path,
    });
  });

  it('deletes a PASTED rider’s text, with no file involved', async () => {
    // George, 2026-08-04: *"add it to the riders as well"* — a rider whose text was pasted
    // has no file, so the file-flavoured ✕ never appeared and there was no way to remove
    // anything from that row. The dialog says "text", not "file", because that is what goes.
    const pasted = (await listAddendums('lease-2')).find((a) => !a.storage_path);
    expect(pasted.addendum_text).toBeTruthy();

    const { container } = mountLease();
    await waitFor(() => expect(riderRows(container).length).toBe(2));
    const row = riderRows(container)[1];
    expect(within(row).queryByRole('button', { name: 'Open file' })).toBeNull();
    fireEvent.click(within(row).getByTitle('Delete the saved text'));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.getAttribute('aria-label')).toBe('Delete the saved text?');
    expect(dialog.textContent).toMatch(/no file to re-read it from/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete text' }));

    await waitFor(() =>
      expect(within(riderRows(container)[1]).queryByRole('button', { name: 'Read text' })).toBeNull()
    );
    expect((await listAddendums('lease-2')).find((a) => a.id === pasted.id).addendum_text).toBeFalsy();
    // The rider stays, and with nothing left to hold it stops offering a ✕ at all.
    expect(riderRows(container)).toHaveLength(2);
    expect(riderRows(container)[1].textContent).toContain('Signage Rider');
    expect(riderRows(container)[1].querySelector('.doc-act3 .icon-btn')).toBeNull();

    await updateAddendum(pasted.id, { addendum_text: pasted.addendum_text });
  });
});
