// Replacing the document a lease is read from. George, 2026-08-04: *"double check that when
// a lease is reuploaded (i dont see the reupload button that we talked about because
// sometimes new leases are made entirely for the same tenant) it is recached and lets the
// user know what will be happening and give them an option to remove the old lease or keep
// it on file, but you should automatically recache with the new lease and let them know."*
//
// He was right that it wasn't there: the panel offered "Add a file" ONLY while a lease had
// none, and a file added that way never reached cache-lease-text at all. Four things have to
// hold, and each one is a way this quietly goes wrong:
//
//   ① the control exists once there IS a file — that was the whole complaint
//   ② the text is genuinely re-read, over the top of the previous transcript
//   ③ the lease's FIGURES do not move — a dropped file must never touch a billed number
//   ④ keep-or-delete is HIS choice, and "keep" really keeps
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseDocs from '../LeaseDocs';
import { ConfirmProvider } from '../ConfirmDialog';
import { supabase } from '../../lib/supabaseClient';
import { getLease, listDocuments } from '../../lib/api';

// lease-2 (City Dental) is the seeded lease that has both a lease_files row and two
// documents — i.e. the only one where "replace" is a real situation.
const LEASE = 'lease-2';

function mount(leaseText = 'x'.repeat(900)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <LeaseDocs leaseId={LEASE} leaseText={leaseText} termLabel="Jun 1, 2024 → May 31, 2026" />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

// The success note is deliberately built from several elements (a tick, a bolded count, the
// filename), so a plain text matcher can't see it as one string — read the note itself.
const doneNote = async () => {
  await waitFor(() => expect(document.querySelector('.note-msg.good')).toBeTruthy());
  return document.querySelector('.note-msg.good');
};

const pick = (name = 'city-dental-2027.pdf') => {
  const input = document.querySelector('input[aria-label="Replace this lease\'s document"]');
  const file = new File(['%PDF-1.4 a newer copy'], name, { type: 'application/pdf' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
};

// The demo store is module-level: put the lease, its file row and its documents back.
const SEED_DOCS = [
  { id: 'doc-1', storage_path: 'demo-user/city-dental-lease.pdf', filename: 'city-dental-lease.pdf' },
  { id: 'doc-2', storage_path: 'demo-user/city-dental-lease-scan.pdf', filename: 'city-dental-lease.pdf' },
];
let snapshot = null;

beforeEach(async () => {
  cleanup();
  const { data: docs } = await supabase.from('documents').select('*');
  const { data: files } = await supabase.from('lease_files').select('*');
  const lease = await getLease(LEASE);
  snapshot = {
    docs: JSON.parse(JSON.stringify(docs || [])),
    files: JSON.parse(JSON.stringify(files || [])),
    lease: JSON.parse(JSON.stringify(lease)),
  };
});

afterEach(async () => {
  // Restore by hand — the mock has no transactions, and every suite after this one reads
  // the same seeded rows.
  const { data: docs } = await supabase.from('documents').select('*');
  for (const d of docs || []) {
    if (!snapshot.docs.some((s) => s.id === d.id)) await supabase.from('documents').delete().eq('id', d.id);
  }
  // …and put back any the test deleted. Without this the "nothing to replace" case strips
  // the seed for every test after it, and they all fail for a reason that isn't theirs.
  for (const d of snapshot.docs) {
    if (!(docs || []).some((x) => x.id === d.id)) await supabase.from('documents').insert(d);
  }
  for (const f of snapshot.files) {
    await supabase.from('lease_files').update({
      storage_path: f.storage_path ?? null, original_filename: f.original_filename ?? null,
    }).eq('id', f.id);
  }
  await supabase.from('leases').update({
    lease_text: snapshot.lease.lease_text, lease_file_id: snapshot.lease.lease_file_id,
  }).eq('id', LEASE);
});

describe('the Replace control', () => {
  // ① The complaint itself.
  it('is offered once the lease has a file, beside Open file', async () => {
    mount();
    // Scoped to the LEASE's own row: the earlier-copy rows below carry an Open file of
    // their own, and an unscoped query would match those too.
    const replace = await screen.findByRole('button', { name: 'Replace' });
    const row = replace.closest('.rider-row');
    expect(row.querySelector('button[title*="Replace"], .doc-act2 button')).toBeTruthy();
    expect(row.textContent).toContain('Open file');
  });

  it('is not offered when there is nothing to replace', async () => {
    // Clear the lease's documents: with no file the row offers "Add a file" instead, and a
    // Replace button would be naming an action with no object.
    for (const d of SEED_DOCS) await supabase.from('documents').delete().eq('id', d.id);
    mount();
    expect(await screen.findByRole('button', { name: 'Add a file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Replace' })).toBe(null);
  });

  // Choosing a file must not BE the action — swapping what the assistant reads is not a
  // thing to happen the instant a picker closes.
  it('explains what will happen before anything is uploaded', async () => {
    mount();
    await screen.findByRole('button', { name: 'Replace' });
    pick();

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('city-dental-2027.pdf');
    expect(dialog.textContent).toContain('re-reads the new document straight away');
    // ③ stated up front, because this is the guarantee that keeps a file drop off the
    // money spine.
    expect(dialog.textContent).toContain('The lease’s own figures do not change');
    // …and the steer for the case George named: an entirely new lease for the same tenant.
    expect(dialog.textContent).toContain('add it as a new lease');
    expect(screen.getByRole('button', { name: 'Replace and re-read' })).toBeTruthy();
  });
});

describe('replacing it', () => {
  // ② The point of the whole thing.
  it('re-reads the document and replaces the saved text, then says how much it read', async () => {
    // The STRING, not the row: the demo mock hands back the live object out of its store,
    // so holding the row would alias the very mutation this is trying to observe.
    const beforeText = (await getLease(LEASE)).lease_text;
    mount();
    await screen.findByRole('button', { name: 'Replace' });
    pick();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace and re-read' }));

    // It reports the outcome in the only terms that mean anything: how much text came back.
    const note = await doneNote();
    expect(note.textContent).toMatch(/Read [\d,]+ characters from city-dental-2027\.pdf/);
    const after = await getLease(LEASE);
    expect(after.lease_text).not.toBe(beforeText);
    expect(after.lease_text).toContain('city-dental-2027.pdf');

    // The lease now points at the new file — this is what makes the NEXT re-read read the
    // right document rather than the one that was just replaced.
    const { data: fileRow } = await supabase.from('lease_files')
      .select('*').eq('id', after.lease_file_id).maybeSingle();
    expect(fileRow.original_filename).toBe('city-dental-2027.pdf');
  });

  // ③ The guarantee, checked rather than asserted in prose.
  it('touches no figure on the lease', async () => {
    // Copied field by field, for the reason above: comparing an aliased row against itself
    // would pass even if every figure had moved, which would make this test worse than none.
    const b = await getLease(LEASE);
    const before = {
      base_rent: b.base_rent, square_footage: b.square_footage, lease_start: b.lease_start,
      lease_termination_date: b.lease_termination_date, lease_terms: b.lease_terms,
    };
    mount();
    await screen.findByRole('button', { name: 'Replace' });
    pick();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace and re-read' }));
    await doneNote();

    const after = await getLease(LEASE);
    expect(after.base_rent).toBe(before.base_rent);
    expect(after.square_footage).toBe(before.square_footage);
    expect(after.lease_start).toBe(before.lease_start);
    expect(after.lease_termination_date).toBe(before.lease_termination_date);
    expect(after.lease_terms).toBe(before.lease_terms);
  });

  // The lease_files row is updated IN PLACE precisely so this survives: extraction_raw on
  // it feeds the CAM/tax estimate pre-fill and the renewal reconcile. A fresh row would
  // blank both without a word.
  it('keeps the AI reading that the estimate pre-fill depends on', async () => {
    const { data: was } = await supabase.from('lease_files').select('*').eq('id', 'lf-1').maybeSingle();
    expect(was.extraction_raw?.est_cam_annual?.value).toBe(12000);

    mount();
    await screen.findByRole('button', { name: 'Replace' });
    pick();
    fireEvent.click(await screen.findByRole('button', { name: 'Replace and re-read' }));
    await doneNote();

    const { data: now } = await supabase.from('lease_files').select('*').eq('id', 'lf-1').maybeSingle();
    expect(now.extraction_raw?.est_cam_annual?.value).toBe(12000);
  });

  // ④ His choice, and it has to mean what it says.
  it('keeps the old file on record by default', async () => {
    const before = (await listDocuments('lease', LEASE)).length;
    mount();
    await screen.findByRole('button', { name: 'Replace' });
    pick();
    // "Keep it on record" is pre-selected — the destructive option is never the default.
    const keep = screen.getByRole('radio', { checked: true });
    expect(keep.closest('label').textContent).toContain('Keep it on record');
    fireEvent.click(screen.getByRole('button', { name: 'Replace and re-read' }));
    await doneNote();

    // One more document than before: the new one, with the old still openable.
    expect((await listDocuments('lease', LEASE)).length).toBe(before + 1);
  });

  it('deletes the old file when he asks it to, and says which happened', async () => {
    mount();
    await screen.findByRole('button', { name: 'Replace' });
    pick();
    fireEvent.click(screen.getByLabelText(/Delete it/));
    fireEvent.click(screen.getByRole('button', { name: 'Replace and re-read' }));
    await doneNote();

    const docs = await listDocuments('lease', LEASE);
    expect(docs.some((d) => d.id === 'doc-1')).toBe(false);
    expect(docs.some((d) => d.filename === 'city-dental-2027.pdf')).toBe(true);
    expect(screen.getByText(/the previous file was deleted/)).toBeTruthy();
  });
});

describe('when the new document cannot be read', () => {
  // The confusing state: the lease points at the new file while the SAVED TEXT is still the
  // old one's. Saying "something went wrong" here would leave the assistant quietly
  // answering from a document that is no longer on the lease.
  it('names exactly what happened rather than showing a bare error', async () => {
    // Fail the read the way a faint scan does — at the function, after the upload has
    // already succeeded. That ordering IS the state being tested.
    const { functions } = supabase;
    const original = functions.invoke.bind(functions);
    functions.invoke = async (name, opts) => (
      name === 'cache-lease-text'
        ? { data: null, error: { message: 'The document could not be read for search.' } }
        : original(name, opts)
    );

    try {
      mount();
      await screen.findByRole('button', { name: 'Replace' });
      pick('too-faint.pdf');
      fireEvent.click(await screen.findByRole('button', { name: 'Replace and re-read' }));

      const warn = await screen.findByText(/couldn’t be read/);
      expect(warn.textContent).toContain('was saved and is now this lease’s document');
      expect(warn.textContent).toContain('The saved text is still the previous document’s');
    } finally {
      functions.invoke = original;
    }
  });
});
