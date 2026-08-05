// Uploading a contract document over a contract that already exists — the contracts-tab
// twin of leaseReplaceDoc, and the flow George asked for on 2026-08-05: *"we need to add
// the same system to the contracts tab."*
//
// The same guarantee, on a different spine:
//   ① the control exists whether or not a document is on file, and says which it is
//   ② READING is not APPLYING — after the read the document and its text are new and every
//      figure is still the old one's, until he confirms
//   ③ the diff he approves is exactly what gets written, old → new
//   ④ the review tells him the two things nothing else on screen would: how many tenants
//      already hold a bill for the year, and that their ESTIMATE is not touched
//   ⑤ applying it moves the CAM line item, the property's CAM total and the stored invoice
//
// Drives the real UI with the demo mock as the database — including the mock's own canned
// extract-contract answer, so the review screen is exercised against the same shape the
// live edge function returns rather than a fixture invented here.
//
// Target: svc-2 (Landscaping — GreenScape), seeded MONTHLY at $1,000 with a +3%/yr scalar
// and no document. The demo's canned landscaping contract is ANNUAL at $12,000 with a fee
// schedule, an auto-renewal and a 30-day cancellation notice — so every kind of change this
// round added shows up in one diff.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ServiceContractsSection from '../ServiceContractsSection';
import { ConfirmProvider } from '../ConfirmDialog';
import {
  getServiceContract, listCamLineItems, getExpenseRecord, listContractEscalations,
  ensureInvoice, getYearInvoice, getLease,
} from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const PROP = 'prop-2';

// The from→to table and the fee-schedule table share a class; only the first is a diff.
const DIFF = '.terms-diff:not(.schedule)';
const diffRows = () => [...document.querySelectorAll(DIFF + ' tbody tr')]
  .map((r) => r.textContent.replace(/\s+/g, ' ').trim());

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <ServiceContractsSection propId={PROP} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

// Contracts render in created_at order, so [0] is the snow agreement and [1] the landscaping.
const pick = (idx = 1, name = 'greenscape-renewal.pdf') => {
  const input = document.querySelectorAll('input[aria-label="Upload a contract document"]')[idx];
  const file = new File(['%PDF-1.4 a renewed contract'], name, { type: 'application/pdf' });
  fireEvent.change(input, { target: { files: [file] } });
};

// ⚠ Matched by regex, not by the exact label: the mock DB is shared across this file, so
// once one test has uploaded, svc-2's button reads "Upload new contract" for the rest.
async function toReview() {
  mount();
  await waitFor(() => expect(document.querySelectorAll('input[aria-label="Upload a contract document"]').length).toBe(2));
  pick();
  fireEvent.click(await screen.findByRole('button', { name: 'Read the contract' }));
  await screen.findByRole('button', { name: 'Apply the new contract' });
}

describe('the upload control', () => {
  // ⚠ NOT gated on a document existing. A contract entered by hand is exactly the one whose
  // figures were never AI-checked, and before this there was no way in at all.
  it('says "Upload new contract" with a document on file and "Upload contract" without', async () => {
    mount();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Upload new contract' })).toBeTruthy(); // svc-1
      expect(screen.getByRole('button', { name: 'Upload contract' })).toBeTruthy();     // svc-2
    });
  });
});

describe('reading is not applying', () => {
  it('the text is replaced, and every figure is still the old contract’s', async () => {
    const before = await getServiceContract('svc-2');
    expect(Number(before.amount)).toBe(1000);
    expect(before.frequency).toBe('monthly');

    await toReview();

    const after = await getServiceContract('svc-2');
    // The document IS the contract's document from this moment…
    expect(after.storage_path).toBeTruthy();
    expect(after.contract_text).toContain('GreenScape');
    // …and not one figure has moved.
    expect(Number(after.amount)).toBe(1000);
    expect(after.frequency).toBe('monthly');
    expect(after.auto_renew ?? null).toBe(null);
    expect(after.notice_by_date ?? null).toBe(null);
  });
});

describe('the review screen', () => {
  it('shows the from→to diff for every figure the document states', async () => {
    await toReview();
    const rows = diffRows();
    expect(rows.some((r) => /Fee.*\$1,000.*\$12,000/.test(r))).toBe(true);
    expect(rows.some((r) => /Frequency.*per month.*per year/.test(r))).toBe(true);
    expect(rows.some((r) => /Auto-renews.*renews unless cancelled/.test(r))).toBe(true);
    expect(rows.some((r) => /Cancellation notice/.test(r))).toBe(true);
  });

  it('says the notice date was CALCULATED, not read off the document', async () => {
    await toReview();
    const info = [...document.querySelectorAll('.note-msg.info')].map((n) => n.textContent).join(' ');
    expect(info).toMatch(/30 days/);
    expect(info).toMatch(/calculated date, not one the document gives/);
  });

  it('shows the dated fee schedule, and names the row it could not use', async () => {
    await toReview();
    const sched = [...document.querySelectorAll('.terms-diff.schedule tbody tr')].map((r) => r.textContent);
    // Two dated rows; the demo's per-visit salting rate is NOT scheduled.
    expect(sched).toHaveLength(2);
    expect(sched.join(' ')).toMatch(/\$12,000/);
    expect(sched.join(' ')).toMatch(/\$12,500/);
    const warns = [...document.querySelectorAll('.note-msg.warn')].map((n) => n.textContent).join(' ');
    expect(warns).toMatch(/priced per visit/);
  });

  it('surfaces the AI’s own red flags before anything is written', async () => {
    await toReview();
    const warns = [...document.querySelectorAll('.note-msg.warn')].map((n) => n.textContent).join(' ');
    expect(warns).toMatch(/Renews itself on a short notice window/);
  });

  // ⚠ The two sentences nothing else on screen would tell him. George's constraint is
  // stated in WORDS because it is the difference between a tenant's bill moving today and
  // moving at the year-end true-up.
  it('names the tenants already billed and promises the estimate is untouched', async () => {
    await ensureInvoice('lease-3', PROP, Y);
    await toReview();
    const extras = [...document.querySelectorAll('.terms-extra li')].map((l) => l.textContent).join(' ');
    expect(extras).toMatch(/tenant/);
    expect(extras).toMatch(/already/);
    expect(extras).toMatch(/CAM . tax estimate/);
    expect(extras).toMatch(/not touched/);
    expect(extras).toMatch(/⚖ Reconcile/);
    // …and that the CAM line keeps the landlord's own label, not the document's.
    expect(extras).toMatch(/Landscaping — GreenScape/);
  });
});

describe('applying it', () => {
  it('moves the figures, the fee schedule, the CAM line and the stored invoice', async () => {
    await ensureInvoice('lease-3', PROP, Y);
    const invBefore = await getYearInvoice('lease-3', Y);
    const camBefore = await getExpenseRecord(PROP, Y);

    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new contract' }));
    await screen.findByRole('button', { name: 'Done' });

    const c = await getServiceContract('svc-2');
    expect(Number(c.amount)).toBe(12000);
    expect(c.frequency).toBe('annual');
    expect(c.auto_renew).toBe(true);
    expect(Number(c.notice_days)).toBe(30);
    // Derived: 30 days before the document's Y+1-12-31 term end.
    expect(c.notice_by_date).toBe(`${Y + 1}-12-01`);
    // ⚠ The name is NOT taken from the document — it is the CAM line's label, the alert's
    // title and the reminder email's subject.
    expect(c.name).toBe('Landscaping — GreenScape');

    // The document's schedule is now the contract's schedule.
    const steps = await listContractEscalations('svc-2');
    expect(steps.map((s) => Number(s.new_amount)).sort((a, b) => a - b)).toEqual([12000, 12500]);

    // Priced by the step in effect for THIS year — 12,000, replacing the 12,360 the seeded
    // monthly-plus-3% scalar produced.
    const item = (await listCamLineItems(PROP, Y)).find((i) => i.contract_id === 'svc-2');
    expect(Number(item.amount)).toBe(12000);

    const camAfter = await getExpenseRecord(PROP, Y);
    expect(Number(camAfter.cam_total)).toBeCloseTo(Number(camBefore.cam_total) - 360, 2);

    // ⚠ THE POINT. The Ledger and the Financials breakdown build UP from live data and
    // would have followed on their own; the stored invoice is a frozen copy that does not.
    // Northwind has no estimate and a 40% share override.
    const invAfter = await getYearInvoice('lease-3', Y);
    expect(Number(invAfter.cam_annual)).not.toBeCloseTo(Number(invBefore.cam_annual), 2);
    expect(Number(invAfter.cam_annual)).toBeCloseTo(Number(camAfter.cam_total) * 0.4, 2);
  });

  it('writes no estimate on any lease at the property', async () => {
    const before = await Promise.all(['lease-3', 'lease-4'].map((id) => getLease(id)));
    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Apply the new contract' }));
    await screen.findByRole('button', { name: 'Done' });
    const after = await Promise.all(['lease-3', 'lease-4'].map((id) => getLease(id)));
    after.forEach((l, i) => {
      expect(l.est_cam_annual ?? null).toBe(before[i].est_cam_annual ?? null);
      expect(l.est_tax_annual ?? null).toBe(before[i].est_tax_annual ?? null);
      expect(l.est_roof_annual ?? null).toBe(before[i].est_roof_annual ?? null);
      expect(l.est_confirmed_year ?? null).toBe(before[i].est_confirmed_year ?? null);
    });
  });

  it('"Keep the current figures" leaves every figure alone but keeps the document', async () => {
    // Compared against whatever the contract holds NOW — earlier tests in this file share
    // the mock DB, and the guarantee is "unchanged", not "still the seed".
    const before = await getServiceContract('svc-2');
    const stepsBefore = await listContractEscalations('svc-2');

    await toReview();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the current figures' }));

    const after = await getServiceContract('svc-2');
    expect(Number(after.amount)).toBe(Number(before.amount));
    expect(after.frequency).toBe(before.frequency);
    expect(after.end_date).toBe(before.end_date);
    expect(after.notice_by_date).toBe(before.notice_by_date);
    expect((await listContractEscalations('svc-2')).length).toBe(stepsBefore.length);
    // …but the read still happened: the document and its text are the new ones.
    expect(after.contract_text).toContain('GreenScape');
  });
});
