// Uploading a NEW lease over the one on file. George asked for a re-upload button, then
// corrected what it should do: *"well if i replace a lease with a new one id want the
// figures to change based on the new lease thats the point so it should say 'upload new
// lease'."*
//
// So the guarantee moved. It is no longer "the figures never move" — it is "the figures
// move, and never before you have seen which":
//
//   ① the control exists once there IS a lease on file, and says what it does
//   ② READING is not APPLYING — after the read the document and text are new and every
//      figure is still the old one's, until he confirms
//   ③ the diff he approves is exactly what gets written, old → new
//   ④ applying it moves the billed figures, replaces the not-yet-applied rent steps, and
//      leaves what already happened alone
//   ⑤ keep-or-delete of the old document is his choice, and "keep" really keeps
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseDocs from '../LeaseDocs';
import { ConfirmProvider } from '../ConfirmDialog';
import { supabase } from '../../lib/supabaseClient';
import { getLease, listDocuments } from '../../lib/api';
import * as api from '../../lib/api';
import { optionScheduleSteps } from '../../lib/renewals';

// lease-2 (City Dental) is the seeded lease with both a lease_files row and documents —
// i.e. the only one where uploading a replacement is a real situation. The demo's canned
// extract-lease answers with the Summit Fitness lease, so the diff is large and obvious.
const LEASE = 'lease-2';
const NEW = { base_rent: 96000, square_footage: 4200, start: '2025-03-01', end: '2030-02-28', camTax: 14700 };

// The from→to table and the rent-schedule table share a class; only the first is a diff.
const DIFF = '.terms-diff:not(.schedule)';
const diffRows = () => [...document.querySelectorAll(DIFF + ' tbody tr')]
  .map((r) => r.textContent.replace(/\s+/g, ' ').trim());

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

// The notes are built from several elements (a tick, a bolded count, a filename), so a
// plain text matcher can't see them as one string — read the note itself.
const note = async (cls = '.note-msg.good') => {
  await waitFor(() => expect(document.querySelector(cls)).toBeTruthy());
  return document.querySelector(cls);
};

const pick = (name = 'city-dental-2027.pdf') => {
  const input = document.querySelector('input[aria-label="Upload a new lease for this tenant"]');
  const file = new File(['%PDF-1.4 a new lease'], name, { type: 'application/pdf' });
  fireEvent.change(input, { target: { files: [file] } });
};

// Walk from the picker to the review screen, which is where most of this lives.
async function toReview(name) {
  mount();
  await screen.findByRole('button', { name: 'Upload new lease' });
  pick(name);
  fireEvent.click(await screen.findByRole('button', { name: 'Read the new lease' }));
  await screen.findByRole('button', { name: 'Apply the new lease' });
}

const SEED_DOCS = ['doc-1', 'doc-2'];
let snapshot = null;

beforeEach(async () => {
  cleanup();
  const { data: docs } = await supabase.from('documents').select('*');
  const { data: files } = await supabase.from('lease_files').select('*');
  const { data: escs } = await supabase.from('rent_escalations').select('*');
  const { data: rens } = await supabase.from('renewal_options').select('*');
  const { data: abs } = await supabase.from('rent_abatements').select('*');
  const lease = await getLease(LEASE);
  snapshot = {
    docs: JSON.parse(JSON.stringify(docs || [])),
    files: JSON.parse(JSON.stringify(files || [])),
    escs: JSON.parse(JSON.stringify(escs || [])),
    rens: JSON.parse(JSON.stringify(rens || [])),
    abs: JSON.parse(JSON.stringify(abs || [])),
    lease: JSON.parse(JSON.stringify(lease)),
  };
});

afterEach(async () => {
  // Restore by hand — the mock has no transactions and every suite after this one reads the
  // same seeded rows.
  const { data: docs } = await supabase.from('documents').select('*');
  for (const d of docs || []) {
    if (!snapshot.docs.some((s) => s.id === d.id)) await supabase.from('documents').delete().eq('id', d.id);
  }
  for (const d of snapshot.docs) {
    if (!(docs || []).some((x) => x.id === d.id)) await supabase.from('documents').insert(d);
  }
  for (const f of snapshot.files) {
    await supabase.from('lease_files').update({
      storage_path: f.storage_path ?? null, original_filename: f.original_filename ?? null,
    }).eq('id', f.id);
  }
  const seeds = {
    rent_escalations: snapshot.escs, renewal_options: snapshot.rens, rent_abatements: snapshot.abs,
  };
  for (const [table, seed] of Object.entries(seeds)) {
    const { data: now } = await supabase.from(table).select('*');
    for (const r of now || []) {
      if (!seed.some((s) => s.id === r.id)) await supabase.from(table).delete().eq('id', r.id);
    }
    for (const r of seed) {
      if (!(now || []).some((x) => x.id === r.id)) await supabase.from(table).insert(r);
    }
  }
  await supabase.from('leases').update({
    lease_text: snapshot.lease.lease_text,
    lease_file_id: snapshot.lease.lease_file_id,
    base_rent: snapshot.lease.base_rent,
    square_footage: snapshot.lease.square_footage,
    lease_start: snapshot.lease.lease_start,
    lease_termination_date: snapshot.lease.lease_termination_date,
    lease_terms: snapshot.lease.lease_terms,
    est_cam_annual: snapshot.lease.est_cam_annual ?? null,
    est_tax_annual: snapshot.lease.est_tax_annual ?? null,
    est_confirmed_year: snapshot.lease.est_confirmed_year ?? null,
    ai_confidence: snapshot.lease.ai_confidence ?? null,
    ai_review: snapshot.lease.ai_review ?? null,
    is_active: snapshot.lease.is_active,
  }).eq('id', LEASE);
});

describe('the control', () => {
  // ① The original complaint, now named for what it actually does.
  it('is offered once the lease has a document, and says “Upload new lease”', async () => {
    mount();
    const btn = await screen.findByRole('button', { name: 'Upload new lease' });
    expect(btn.closest('.rider-row').textContent).toContain('Open file');
  });

  // ⚠ This used to assert the OPPOSITE — that the AI lane is hidden for a lease with no
  // document. That made a lease entered by hand the one lease whose figures were never
  // AI-checked at all: its first document went through the plain "Add a file" path, stored
  // and never read. uploadNewLeaseDocument already handles a lease with no lease_files row,
  // so the only thing missing was the way in. The label drops "new" when there is nothing to
  // replace, because there isn't.
  it('is offered even when the lease has no document yet, reading “Upload lease”', async () => {
    for (const id of SEED_DOCS) await supabase.from('documents').delete().eq('id', id);
    mount();
    expect(await screen.findByRole('button', { name: 'Upload lease' })).toBeTruthy();
    // "Add a file" is still there for storing a document without reading it.
    expect(screen.getByRole('button', { name: 'Add a file' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Upload new lease' })).toBe(null);
  });

  it('says the figures will change, and that a closed year is left alone', async () => {
    mount();
    await screen.findByRole('button', { name: 'Upload new lease' });
    pick();
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('city-dental-2027.pdf');
    expect(dialog.textContent).toContain('reads the new lease');
    expect(dialog.textContent).toContain('exactly which figures change');
    expect(dialog.textContent).toContain('updates this tenant’s bill');
    expect(dialog.textContent).toContain('already closed is left alone');
  });
});

describe('reading it', () => {
  // ② The most important test in the file. The read is paid for and irreversible; the
  // APPLY is the part that moves money, and between them every figure must still be the
  // old one's.
  it('re-reads the text but moves no figure until it is applied', async () => {
    const b = await getLease(LEASE);
    const before = { base_rent: b.base_rent, square_footage: b.square_footage, lease_start: b.lease_start };
    const beforeText = b.lease_text;

    await toReview();

    const after = await getLease(LEASE);
    expect(after.lease_text).not.toBe(beforeText);        // the document IS new
    expect(after.base_rent).toBe(before.base_rent);        // the figures are NOT
    expect(after.square_footage).toBe(before.square_footage);
    expect(after.lease_start).toBe(before.lease_start);
  });

  // ③ Old beside new, so nothing has to be taken on trust.
  it('shows every figure that would change, old beside new', async () => {
    await toReview();
    const rows = diffRows();

    expect(rows.some((r) => /Base rent.*84,000.*96,000/.test(r))).toBe(true);
    expect(rows.some((r) => /Square footage.*3,000.*4,200/.test(r))).toBe(true);
    // This lease holds no estimate at all, so "Now" must read as a blank — "$0.00" would
    // claim somebody had entered a zero, which is a different statement entirely.
    expect(rows.some((r) => /CAM & tax estimate—\$14,700\.00/.test(r))).toBe(true);
    // Rent and size rebuild an invoice; they are marked as the ones that do.
    expect(document.querySelectorAll(DIFF + ' tr.billed').length).toBeGreaterThanOrEqual(2);
    // The schedule is described in words rather than left as a surprise.
    const extra = document.querySelector('.terms-extra').textContent;
    expect(extra).toContain('rent step-up');
    expect(extra).toContain('renewal option');
    expect(extra).toContain('is rebuilt');
  });

  // George, 2026-08-04: *"if the rent escalation in the new lease is found the ledger needs
  // to show."* A count is not a schedule — the DATES are what he checks against the document
  // in his hand, and they are the one thing a count can't be checked against.
  it('shows the new lease’s rent steps as dates and amounts, not as a count', async () => {
    await toReview();
    const steps = [...document.querySelectorAll('.terms-diff.schedule tbody tr')]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    expect(steps.length).toBe(1);
    // 3% on $96,000, effective March 1 2026 — the step the canned lease prints.
    expect(steps[0]).toMatch(/March 1, 2026/);
    expect(steps[0]).toMatch(/98,880/);
    // And the reason the rent won't read $96,000 afterwards is stated, not left to be
    // discovered — that step is already in the past.
    expect(document.querySelector('.terms-extra').textContent).toContain('already dated in the past');
  });

  // The option priced year by year: captured on the new-tenant import from the start, and
  // silently dropped here until now.
  it('says the renewal option’s own rent schedule is captured too', async () => {
    await toReview();
    const text = document.querySelector('.modal').textContent;
    expect(text).toContain('priced year by year');
    expect(text).toContain('pending renewal');
    expect(text).toMatch(/111,300/);
  });

  // The CAM & tax estimate is what the tenant is billed all year. A new lease that prices it
  // and is applied without it bills the OLD document's estimate against the NEW rent.
  it('shows the CAM & tax estimate the new lease states, marked as a billed figure', async () => {
    await supabase.from('leases').update({ est_cam_annual: 9000, est_tax_annual: 0 }).eq('id', LEASE);
    await toReview();
    const row = diffRows().find((r) => /CAM & tax estimate/.test(r));
    expect(row).toBeTruthy();
    expect(row).toMatch(/9,000.*14,700/);
    expect([...document.querySelectorAll(DIFF + ' tr.billed')]
      .some((r) => /CAM & tax estimate/.test(r.textContent))).toBe(true);
  });

  // A document that restates the figures already on file must not present them as changes.
  it('shows no figure rows when the new lease states what is already on the lease', async () => {
    await supabase.from('leases').update({
      base_rent: NEW.base_rent, square_footage: NEW.square_footage,
      lease_start: NEW.start, lease_termination_date: NEW.end,
      lease_terms: 'NNN; 3% annual escalations.',
      est_cam_annual: NEW.camTax, est_tax_annual: 0,
    }).eq('id', LEASE);

    await toReview();
    // Not one row, and the dialog says why rather than showing an empty table.
    expect(diffRows().length).toBe(0);
    expect(screen.getByText(/No stored figure changes/)).toBeTruthy();
    // The schedule is still worth applying — the new lease's steps and options replace
    // the old ones even when every stored figure happens to match.
    expect(document.querySelector('.terms-extra').textContent).toContain('rent step-up');
  });
});

describe('applying it', () => {
  // ④ The point of the whole change.
  it('writes the new figures onto the lease', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => {
      expect(Number((await getLease(LEASE)).square_footage)).toBe(NEW.square_footage);
    });
    const after = await getLease(LEASE);
    expect(after.lease_start).toBe(NEW.start);
    expect(after.lease_termination_date).toBe(NEW.end);

    // ⚠ NOT 96,000 — and that is correct. The new lease prices its own 3% step from
    // 2026-03-01, which is in the past, so backfillLeaseToToday applies it on the way out
    // exactly as it does for a rider. The lease's committed rent is the schedule brought
    // up to today, not the figure printed on page 1.
    expect(Number(after.base_rent)).toBe(Math.round(NEW.base_rent * 1.03));
  });

  it('replaces the rent steps that had not happened yet, and keeps the ones that had', async () => {
    const { data: applied } = await supabase.from('rent_escalations')
      .insert({
        lease_id: LEASE, owner_id: 'demo-user', effective_date: '2024-06-01',
        escalation_type: 'manual', new_base_rent: 84000, status: 'applied',
      }).select();
    const keptId = applied?.[0]?.id;

    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    // The new lease's own step, on file. Its status is 'applied' rather than 'scheduled'
    // because its date has already passed — backfillLeaseToToday runs at the end of the
    // apply, the same way it does for a rider.
    await waitFor(async () => {
      const { data } = await supabase.from('rent_escalations').select('*').eq('lease_id', LEASE);
      expect(data.some((e) => e.effective_date === '2026-03-01')).toBe(true);
    });

    // An applied step is a thing that happened — rewriting it is how a past invoice stops
    // matching the ledger that explains it.
    const { data: now } = await supabase.from('rent_escalations').select('*').eq('lease_id', LEASE);
    expect(now.some((e) => e.id === keptId)).toBe(true);
  });

  // The whole reason the estimate is in the diff: it is billed every month of the year.
  it('writes the CAM & tax estimate the merged way the app bills from', async () => {
    await supabase.from('leases').update({ est_cam_annual: 9000, est_tax_annual: 4000 }).eq('id', LEASE);
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => {
      expect(Number((await getLease(LEASE)).est_cam_annual)).toBe(NEW.camTax);
    });
    const after = await getLease(LEASE);
    // ⚠ The tax half must be ZEROED, not left where it was. est_cam_annual holds the
    // COMBINED figure and every reader sums the two, so leaving $4,000 beside it would bill
    // $18,700 against a lease that says $14,700.
    expect(Number(after.est_tax_annual)).toBe(0);
    expect(Number(after.est_confirmed_year)).toBe(new Date().getFullYear());
  });

  // George: *"the renewal options need to update."* An option priced year by year has to
  // reach the ledger as dated rent, or the Renewal Options tab knows about a term the
  // ledger shows as "Not listed" for all five years of it.
  it('saves the renewal option’s year-by-year rent past the term end', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => {
      const { data } = await supabase.from('rent_escalations').select('*').eq('lease_id', LEASE);
      expect(data.some((e) => e.effective_date === '2030-03-01')).toBe(true);
    });
    const { data: now } = await supabase.from('rent_escalations').select('*').eq('lease_id', LEASE);
    const past = now.filter((e) => e.effective_date > NEW.end);
    // Five option years, each dated, and all still SCHEDULED — they are projections gated
    // behind confirming the option, not rent anyone owes.
    expect(past.length).toBe(5);
    expect(past.every((e) => e.status === 'scheduled')).toBe(true);
    expect(Number(past.find((e) => e.effective_date === '2030-03-01').new_base_rent)).toBe(111300);
    // …and the option row itself is on file with the rent it opens at.
    const { data: rens } = await supabase.from('renewal_options').select('*').eq('lease_id', LEASE);
    expect(rens.some((r) => r.status === 'pending' && Number(r.new_rent) === 111300)).toBe(true);
  });

  // ── §12 ───────────────────────────────────────────────────────────────────────────────
  // Four things extract-lease emits are rendered on the new-tenant intake screen and reached
  // nowhere near this dialog — the one where figures move on a lease that already exists. The
  // red flags were the sharpest: applying WRITES ai_review onto the lease, so the landlord met
  // them only after committing. George: *"the lease extractor needs to be as good as the
  // original one we made for the new tenants."*
  it('shows the AI’s red flags, its disagreements and its notes BEFORE applying', async () => {
    await toReview();
    const dialog = screen.getByRole('dialog');
    // The canned extraction carries red flags; they are named, not just stored.
    expect(dialog.textContent).toMatch(/The AI flagged/i);
    // The analyst's brief is offered, with the machine-readable VERDICTS line stripped.
    const notes = screen.getByText(/Read the AI analyst’s notes/i);
    expect(notes).toBeTruthy();
    expect(notes.closest('details').textContent).not.toMatch(/VERDICTS:/);
  });

  // ── §10 ───────────────────────────────────────────────────────────────────────────────
  // initialFromExtraction falls back to the SIGNING date when a lease prints no commencement
  // date. On the intake FORM that is an editable suggestion; here the review is a read-only
  // table, and the value would become boundaryIso — the date the whole rent-era and CAM-era
  // split hangs off. George, 2026-08-05: don't apply a guessed date at all.
  it('will not apply a lease start the document never printed, and says why', async () => {
    const before = await getLease(LEASE);
    // The same canned read with NO printed commencement date — only a signing date, which is
    // what initialFromExtraction would otherwise stand in for the start.
    const real = api.uploadNewLeaseDocument;
    const spy = vi.spyOn(api, 'uploadNewLeaseDocument').mockImplementation(async (args) => {
      const res = await real(args);
      return {
        ...res,
        extraction: {
          ...res.extraction,
          lease_start: { value: null, confidence: 0, source_quote: '', page: 1 },
          execution_date: { value: '2025-01-15', confidence: 0.9, source_quote: 'entered into as of January 15, 2025', page: 1 },
        },
      };
    });
    try {
      await toReview();
      expect(screen.getByRole('dialog').textContent).toMatch(/prints no lease start/i);
      // …and it is NOT in the table of what changes, because it isn't going to change.
      expect(diffRows().some((r) => /Lease start/.test(r))).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
      await waitFor(async () => expect(Number((await getLease(LEASE)).base_rent)).not.toBe(Number(before.base_rent)));
      // The rest of the document applied; the start is untouched — not set to the signing date.
      expect((await getLease(LEASE)).lease_start).toBe(before.lease_start);
    } finally { spy.mockRestore(); }
  });

  // ── §5 ────────────────────────────────────────────────────────────────────────────────
  // Applying DELETES the pending options and re-inserts them from buildRenewals, which used
  // to emit neither of these — so a re-upload silently dropped both. rent_schedule (0071) is
  // what optionScheduleSteps materialises when the landlord later confirms the renewal;
  // notice_lead_n / notice_lead_unit (0072) are a LANDLORD setting no document states, so
  // nothing could have re-derived them.
  it('carries the option’s rent schedule and the landlord’s notice lead across the replacement', async () => {
    const { data: before } = await supabase.from('renewal_options').select('*').eq('lease_id', LEASE);
    const pending = before.filter((r) => r.status === 'pending');
    // Set a lead by hand, the way the Renewal Options editor does.
    await supabase.from('renewal_options').update({ notice_lead_n: 9, notice_lead_unit: 'months' })
      .eq('id', pending[0].id);

    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => {
      const { data } = await supabase.from('renewal_options').select('*').eq('lease_id', LEASE);
      expect(data.some((r) => r.status === 'pending' && r.id !== pending[0].id)).toBe(true);
    });

    const { data: after } = await supabase.from('renewal_options').select('*').eq('lease_id', LEASE);
    const now = after.filter((r) => r.status === 'pending');
    expect(now.length).toBeGreaterThan(0);
    // The document's own year-by-year table is on the row, as an array the reader speaks.
    expect(Array.isArray(now[0].rent_schedule)).toBe(true);
    expect(now[0].rent_schedule.length).toBeGreaterThan(0);
    expect(optionScheduleSteps(now[0].rent_schedule).length).toBeGreaterThan(0);
    // …and the lead the landlord chose is still his, matched by position.
    expect(Number(now[0].notice_lead_n)).toBe(9);
    expect(now[0].notice_lead_unit).toBe('months');
  });

  // ── §13 ───────────────────────────────────────────────────────────────────────────────
  // Abatements are added and never cleared (an issued invoice may already carry the credit),
  // but "never cleared" was also "never deduped" — so applying the same document twice, which
  // is exactly what a landlord does after a failure part way through, listed the same free
  // period twice on the lease.
  it('does not add the same free-rent window twice when the document is applied again', async () => {
    await supabase.from('rent_abatements')
      .insert({ lease_id: LEASE, owner_id: 'demo-user', start_date: '2025-03-01', end_date: '2025-05-31', kind: 'free', value: null });
    const { data: before } = await supabase.from('rent_abatements').select('*').eq('lease_id', LEASE);

    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => expect(Number((await getLease(LEASE)).square_footage)).toBe(NEW.square_footage));

    const { data: after } = await supabase.from('rent_abatements').select('*').eq('lease_id', LEASE);
    const key = (a) => `${a.start_date}|${a.end_date}|${a.kind}`;
    expect(new Set(after.map(key)).size).toBe(after.length); // no duplicate windows
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  // A badge saying "91% confident" beside a square footage read out of a file that is no
  // longer on the lease is worse than no badge.
  it('moves the AI’s confidence and red-flag review onto the new document’s read', async () => {
    await supabase.from('leases').update({
      ai_confidence: { base_rent: 0.11 }, ai_review: { flags: [{ key: 'stale', title: 'From the old lease' }] },
    }).eq('id', LEASE);
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => {
      expect(Number((await getLease(LEASE)).ai_confidence?.base_rent)).toBe(0.88);
    });
    const after = await getLease(LEASE);
    expect((after.ai_review?.flags || []).some((f) => f.key === 'stale')).toBe(false);
    expect((after.ai_review?.flags || []).some((f) => f.key === 'no_personal_guarantee')).toBe(true);
  });

  it('records it in the history with every figure’s old and new value', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await waitFor(async () => {
      const { data } = await supabase.from('history_events').select('*').eq('lease_id', LEASE);
      expect((data || []).some((e) => e.type === 'lease_replaced')).toBe(true);
    });

    const { data: events } = await supabase.from('history_events').select('*').eq('lease_id', LEASE);
    const ev = events.find((e) => e.type === 'lease_replaced');
    const rent = (ev.meta?.fields || []).find((f) => f.key === 'base_rent');
    expect(Number(rent.from)).toBe(Number(snapshot.lease.base_rent));
    expect(Number(rent.to)).toBe(NEW.base_rent);
  });

  // The escape hatch: he can take the new document and keep his own numbers.
  it('leaves every figure alone if he keeps the current ones', async () => {
    const before = Number((await getLease(LEASE)).base_rent);
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the current figures' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBe(null));
    const after = await getLease(LEASE);
    expect(Number(after.base_rent)).toBe(before);
    // …but the new document and its text stay, because that part already happened.
    expect(after.lease_text).not.toBe(snapshot.lease.lease_text);
  });
});

describe('the old document', () => {
  // ⑤ His choice, pre-set to the one that loses nothing.
  it('is kept by default', async () => {
    const before = (await listDocuments('lease', LEASE)).length;
    mount();
    await screen.findByRole('button', { name: 'Upload new lease' });
    pick();
    const keep = screen.getByRole('radio', { checked: true });
    expect(keep.closest('label').textContent).toContain('Keep it on record');
    fireEvent.click(screen.getByRole('button', { name: 'Read the new lease' }));
    await screen.findByRole('button', { name: 'Apply the new lease' });
    expect((await listDocuments('lease', LEASE)).length).toBe(before + 1);
  });

  it('is deleted when he asks for that instead', async () => {
    mount();
    await screen.findByRole('button', { name: 'Upload new lease' });
    pick();
    fireEvent.click(screen.getByLabelText(/Delete it/));
    fireEvent.click(screen.getByRole('button', { name: 'Read the new lease' }));
    await screen.findByRole('button', { name: 'Apply the new lease' });

    const docs = await listDocuments('lease', LEASE);
    expect(docs.some((d) => d.id === 'doc-1')).toBe(false);
    expect(docs.some((d) => d.filename === 'city-dental-2027.pdf')).toBe(true);
  });

  // The AI reading on the lease_files row feeds the CAM/tax estimate pre-fill and the
  // renewal reconcile. The row is updated IN PLACE precisely so a new document can't blank
  // them without a word.
  it('keeps the AI reading the estimate pre-fill depends on', async () => {
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new lease' }));
    await note();
    const { data: row } = await supabase.from('lease_files').select('*').eq('id', 'lf-1').maybeSingle();
    expect(row.extraction_raw?.est_cam_annual?.value).toBe(12000);
  });
});

describe('when the new lease cannot be read', () => {
  // The middle state, named exactly: the document is already the lease's document while
  // every figure is still the old one's. A bare error would leave that unsaid.
  it('says the document changed and the figures did not', async () => {
    const { functions } = supabase;
    const original = functions.invoke.bind(functions);
    functions.invoke = async (name, opts) => (
      name === 'extract-lease' || name === 'cache-lease-text'
        ? { data: null, error: { message: 'The document could not be read for search.' } }
        : original(name, opts)
    );

    try {
      mount();
      await screen.findByRole('button', { name: 'Upload new lease' });
      pick('too-faint.pdf');
      fireEvent.click(await screen.findByRole('button', { name: 'Read the new lease' }));

      const warn = await note('.note-msg.warn');
      expect(warn.textContent).toContain('is now this lease’s document');
      expect(warn.textContent).toContain('every figure are still the');
    } finally {
      functions.invoke = original;
    }
  });
});
