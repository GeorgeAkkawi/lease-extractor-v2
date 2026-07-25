// Render test for the rider review screen. Mounts the REAL AddendumEditor against the demo
// mock (DEMO mode is forced by the test env), drives the AI lane through the same "Paste
// text instead → Extract with AI" path a landlord uses, and checks the four things the
// audit found broken between the extractor and the database:
//
//   1) a PERCENT rent step reaches the form (it used to vanish — the mock's canned rider
//      has shipped a live reproduction all along: its summary promises a 3% bump the form
//      never showed) and can be saved;
//   2) a QUOTED / superseded rent is reported, not applied;
//   3) the analyst's disagreement flag renders when the brief and the form disagree;
//   4) the uploaded document's storage_path is actually written onto the record.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AddendumEditor from '../AddendumEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import * as api from '../../lib/api';
import {
  createCorporation, createProperty, createLease, listAddendums, listEscalations,
} from '../../lib/api';

async function freshLease() {
  const corp = await createCorporation('Rider Review Holdings');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Review Plaza', address: '1 Review St', building_sf: 10000 });
  return createLease({
    property_id: prop.id, tenant_name: 'Review Tenant LLC', square_footage: 4000,
    base_rent: 120000, lease_start: '2020-01-01', lease_termination_date: '2028-12-31',
  });
}

function mount(leaseId) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <AddendumEditor leaseId={leaseId} leaseInactive={false} squareFootage={4000} currentTermEnd="2028-12-31" />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

// Open the add panel and run the canned extraction through the paste lane.
async function extractCanned() {
  fireEvent.click(await screen.findByRole('button', { name: /Add addendum \/ rider/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Paste text instead/i }));
  fireEvent.change(screen.getByPlaceholderText(/Paste the addendum/i), { target: { value: 'FIRST AMENDMENT…' } });
  fireEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));
  await waitFor(() => expect(screen.getByText(/Here's what the AI read/i)).toBeTruthy());
}

describe('AddendumEditor — the AI review screen', () => {
  it('a percent rent step survives intake and saves as a percent escalation', async () => {
    const lease = await freshLease();
    mount(lease.id);
    await extractCanned();

    const y = new Date().getFullYear();

    // The canned rider sets $132,000/yr now and a 3% bump two years out. BOTH rows must be
    // on the form — the percent one is the row that used to disappear.
    const typeSelects = screen.getAllByDisplayValue(/Amount \(\$\/yr\)|\+% per step/);
    expect(typeSelects).toHaveLength(2);
    expect(typeSelects[0].value).toBe('manual');
    expect(typeSelects[1].value).toBe('percent');
    expect(screen.getByDisplayValue('132000')).toBeTruthy();
    expect(screen.getByDisplayValue('3')).toBeTruthy(); // the percent, not a dollar figure
    expect(screen.getByText(/computed from the rent in effect just before it/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save & apply/i }));
    await waitFor(async () => expect((await listAddendums(lease.id)).length).toBe(1));

    const escs = (await listEscalations(lease.id)).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    expect(escs).toHaveLength(2);
    expect(Number(escs[0].new_base_rent)).toBe(132000);
    expect(escs[1].escalation_type).toBe('percent');
    expect(Number(escs[1].escalation_value)).toBe(3);
    expect(escs[1].effective_date).toBe(`${y + 2}-01-01`);
    // 132,000 × 1.03 — priced from the prior step, never carried from the model.
    expect(Number(escs[1].new_base_rent)).toBeCloseTo(135960, 2);
  });

  it('a quoted / superseded rent is reported but never becomes a step', async () => {
    const lease = await freshLease();
    mount(lease.id);
    await extractCanned();

    // The canned rider recites a prior $10,000/mo clause. It must be named on screen…
    expect(screen.getByText(/quotes a prior rent it replaces/i)).toBeTruthy();
    expect(screen.getByText(/\$120,000\.00/)).toBeTruthy();
    // …and must NOT appear as a rent row (only the two operative rows exist).
    expect(screen.queryByDisplayValue('120000')).toBeNull();
    expect(screen.getAllByDisplayValue(/Amount \(\$\/yr\)|\+% per step/)).toHaveLength(2);
  });

  it("shows the analyst's notes, and flags a disagreement when one is reported", async () => {
    const lease = await freshLease();
    // Force the mismatch the edge function would compute: the analyst says the rider
    // assigns the lease, but nothing landed on the assignment card.
    const real = api.extractAddendum;
    const spy = vi.spyOn(api, 'extractAddendum').mockImplementation(async (args) => {
      const res = await real(args);
      return { ...res, fields: { ...res.fields, extraction_mismatch: ['assignment'] } };
    });
    try {
      mount(lease.id);
      await extractCanned();
      expect(screen.getByText(/an assignment to a new tenant/i)).toBeTruthy();
      // The brief is readable, with its machine-readable VERDICTS line stripped off.
      const notes = screen.getByText(/Read the AI analyst's notes/i);
      expect(notes).toBeTruthy();
      const details = notes.closest('details');
      expect(within(details).getByText(/WHAT THIS DOCUMENT CHANGES/i)).toBeTruthy();
      expect(details.textContent).not.toMatch(/VERDICTS:/);
    } finally {
      spy.mockRestore();
    }
  });

  it('the uploaded document is linked to the record it created', async () => {
    const lease = await freshLease();
    // uploadDoc + extractAddendum are stubbed so the test never touches storage; what's
    // under test is that onFile carries the returned path all the way into createAddendum.
    const realExtract = api.extractAddendum;
    const up = vi.spyOn(api, 'uploadDoc').mockResolvedValue('lease-docs/rider-123.pdf');
    const ex = vi.spyOn(api, 'extractAddendum').mockImplementation((args) => realExtract(args));
    try {
      mount(lease.id);
      fireEvent.click(await screen.findByRole('button', { name: /Add addendum \/ rider/i }));
      const file = new File(['%PDF-1.4'], 'rider.pdf', { type: 'application/pdf' });
      fireEvent.change(screen.getByLabelText(/Upload addendum file/i), { target: { files: [file] } });
      await waitFor(() => expect(screen.getByText(/Here's what the AI read/i)).toBeTruthy());

      fireEvent.click(screen.getByRole('button', { name: /Save & apply/i }));
      await waitFor(async () => expect((await listAddendums(lease.id)).length).toBe(1));
      const [saved] = await listAddendums(lease.id);
      expect(saved.storage_path).toBe('lease-docs/rider-123.pdf');
      expect(up).toHaveBeenCalledTimes(1);
    } finally {
      up.mockRestore(); ex.mockRestore();
    }
  });
});
