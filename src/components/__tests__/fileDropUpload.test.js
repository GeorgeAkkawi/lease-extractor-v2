// Dragging a file onto the thing it belongs to — the shared implementation every picker in
// the app now uses (src/components/FileDrop.js).
//
// George, 2026-08-05: *"make a drag and drop feature for uploading all places you have to
// choose a file."*
//
// The matcher is unit-tested because it is the part with no visible failure: the native
// picker enforces `accept` itself, a DROP does not, so without it the app would happily
// upload a .zip — or a folder, which arrives as a File with no type and no extension — and
// spend an AI read on it. The rest is driven through two real hosts, because what only a
// render can prove is that the drop LANDS: that the target is the whole card and not just
// the button, and that a refusal says something a person can read.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import DocumentsList from '../DocumentsList';
import RiderDocs from '../RiderDocs';
import { fileMatchesAccept, acceptWords } from '../FileDrop';
import { listDocuments } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';

const file = (name, type = 'application/pdf') => new File(['%PDF-1.4'], name, { type });

// jsdom has no DataTransfer, so the event carries exactly the shape the handler reads:
// `types` (what decides whether this is a file drag at all) and `files`.
const transfer = (files) => ({ types: ['Files'], files, dropEffect: '' });

const drop = (el, files) => {
  fireEvent.dragEnter(el, { dataTransfer: transfer(files) });
  fireEvent.dragOver(el, { dataTransfer: transfer(files) });
  fireEvent.drop(el, { dataTransfer: transfer(files) });
};

function mount(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>{ui}</ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe('what a drop is allowed to be', () => {
  it('matches by extension, by mime wildcard and by exact mime', () => {
    expect(fileMatchesAccept(file('lease.pdf'), '.pdf,.docx,image/*')).toBe(true);
    expect(fileMatchesAccept(file('rider.DOCX'), '.pdf,.docx,image/*')).toBe(true);
    expect(fileMatchesAccept(file('scan.png', 'image/png'), '.pdf,.docx,image/*')).toBe(true);
    expect(fileMatchesAccept(file('book.csv', 'text/csv'), '.csv,.pdf')).toBe(true);
  });

  it('refuses what the picker itself would never have offered', () => {
    expect(fileMatchesAccept(file('payload.zip', 'application/zip'), '.pdf,.docx,image/*')).toBe(false);
    expect(fileMatchesAccept(file('notes.txt', 'text/plain'), '.pdf,.png,.jpg,.jpeg,.webp')).toBe(false);
  });

  // ⚠ A FOLDER. Dropping one hands over a File with an empty type and no extension — it
  // matches nothing, which is the only reason it doesn't reach the uploader.
  it('refuses a dropped folder', () => {
    expect(fileMatchesAccept(new File([], 'Invoices', { type: '' }), '.pdf,.docx,image/*')).toBe(false);
  });

  it('accepts anything when nothing was specified', () => {
    expect(fileMatchesAccept(file('x.zip', 'application/zip'), '')).toBe(true);
  });

  it('says what it wanted in words, not in an accept string', () => {
    expect(acceptWords('.pdf,.docx,image/*')).toBe('a PDF, a Word .docx or an image');
    expect(acceptWords('.csv')).toBe('a CSV');
  });
});

describe('a list of copies takes a dropped file', () => {
  // The contract's own documents list — the same component insurance policies use.
  const CONTRACT = 'svc-1';
  let seeded = [];
  beforeEach(async () => {
    seeded = (await listDocuments('service_contract', CONTRACT)).map((d) => d.id);
  });
  afterEach(async () => {
    const now = await listDocuments('service_contract', CONTRACT);
    for (const d of now) {
      if (!seeded.includes(d.id)) await supabase.from('documents').delete().eq('id', d.id);
    }
  });

  const list = async () => {
    mount(<DocumentsList entityType="service_contract" entityId={CONTRACT} title="Saved copies" addLabel="Add a copy" />);
    await screen.findByText('Saved copies');
    const el = document.querySelector('.doc-list.filedrop');
    expect(el).toBeTruthy();
    return el;
  };

  // ⚠ THE WHOLE LIST, not the button. Aiming at a 90px "Add a copy" is not what anyone
  // does with a file in their hand.
  it('files it, and it is the list that is the target', async () => {
    const el = await list();
    drop(el, [file('endorsement-2027.pdf')]);
    expect(await screen.findByText('endorsement-2027.pdf')).toBeTruthy();
    const docs = await listDocuments('service_contract', CONTRACT);
    expect(docs.some((d) => d.filename === 'endorsement-2027.pdf')).toBe(true);
  });

  it('says so while a file is over it, and says nothing at rest', async () => {
    const el = await list();
    expect(document.querySelector('.filedrop-veil')).toBe(null);
    fireEvent.dragEnter(el, { dataTransfer: transfer([file('a.pdf')]) });
    expect(document.querySelector('.filedrop-veil')?.textContent).toMatch(/Drop to add a copy/i);
    fireEvent.dragLeave(el, { dataTransfer: transfer([file('a.pdf')]) });
    await waitFor(() => expect(document.querySelector('.filedrop-veil')).toBe(null));
  });

  it('refuses the wrong kind of file by name, and uploads nothing', async () => {
    const el = await list();
    drop(el, [file('payload.zip', 'application/zip')]);
    expect(await screen.findByText(/payload\.zip/)).toBeTruthy();
    expect(screen.getByText(/isn’t something this can read/)).toBeTruthy();
    const docs = await listDocuments('service_contract', CONTRACT);
    expect(docs.some((d) => d.filename === 'payload.zip')).toBe(false);
  });

  // Quietly taking the first of five would look like all five had been taken.
  it('refuses a handful at once rather than silently keeping one', async () => {
    const el = await list();
    drop(el, [file('one.pdf'), file('two.pdf'), file('three.pdf')]);
    expect(await screen.findByText(/3 files were dropped/)).toBeTruthy();
    const docs = await listDocuments('service_contract', CONTRACT);
    expect(docs.some((d) => d.filename === 'one.pdf')).toBe(false);
  });

  it('ignores a drag that carries no file at all', async () => {
    const el = await list();
    fireEvent.dragEnter(el, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(document.querySelector('.filedrop-veil')).toBe(null);
  });
});

describe('a rider row is its own target', () => {
  const RIDER = { id: 'add-1', label: 'First Amendment', storage_path: null, addendum_text: 'text' };
  const FILED = { id: 'add-2', label: 'Second Amendment', storage_path: 'x/y.pdf' };

  // A drop has to name which rider it belongs to, and the row is the only thing that does.
  it('attaches the file to the row it landed on', async () => {
    const spy = vi.spyOn(supabase, 'from');
    mount(<RiderDocs riders={[RIDER]} leaseId="lease-1" />);
    const row = await screen.findByText(/First Amendment/);
    const target = row.closest('.rider-row');
    expect(target.classList.contains('filedrop')).toBe(true);
    drop(target, [file('first-amendment.pdf')]);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });

  // ⚠ The row's own button offers "Add a file" only where there is none — a drop must not
  // be able to swap the document a rider points at without the ✕ that names what is lost.
  it('refuses to replace a file that is already there', async () => {
    mount(<RiderDocs riders={[FILED]} leaseId="lease-1" />);
    const row = (await screen.findByText(/Second Amendment/)).closest('.rider-row');
    drop(row, [file('replacement.pdf')]);
    expect(await screen.findByText(/already has a file/)).toBeTruthy();
  });
});
