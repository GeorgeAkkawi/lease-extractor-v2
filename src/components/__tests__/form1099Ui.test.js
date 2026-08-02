// Slice 7b in the DOM. Mounts the REAL corporation grid and the REAL worksheet modal
// against the demo mock.
//
// What matters here is not that a list renders — it is that the screen ASKS rather than
// asserts, and names what it could not rule out. A worksheet that quietly drops a vendor
// costs $60–$680 per missing form; one that quietly files an uncategorized bucket as
// "not reportable" looks finished and is wrong in the expensive direction.
//
// The demo seed carries the cases at once on Maple Plaza: "Security" ($6,000) has no tax
// category, every name comes from an expense BUCKET rather than a payee, nothing has a
// payment method on record (round 6's audit rows are forward-only), and $25,000 of
// property taxes is a flat figure nobody itemized.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CorporationsPage from '../../pages/CorporationsPage';
import Export1099Modal from '../Export1099Modal';
import { ChromeProvider } from '../../context/ChromeContext';
import { currentYear } from '../../lib/format';
import { thresholdFor } from '../../lib/form1099';

const Y = currentYear();

const withProviders = (ui, path = '/financials') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>{ui}</ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const grid = (mode) => withProviders(
  <Routes><Route path={`/${mode}`} element={<CorporationsPage mode={mode} />} /></Routes>,
  `/${mode}`
);

const openModal = async () => {
  withProviders(<Export1099Modal corporationId="corp-1" corporationName="Acme Holdings" year={Y} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByText(/Above \$/)).toBeTruthy());
  return screen.getByRole('dialog');
};

const flagText = (dlg) => [...dlg.querySelectorAll('.cpa-flag')].map((f) => f.textContent).join(' ');

beforeEach(() => cleanup());

describe('where the worksheet is offered', () => {
  // Its own control rather than a sheet inside the tax package: 1099s are due January 31
  // and the return is not, so burying it there makes it late by construction.
  //
  // ⚠ Round 15 moved it one click deeper. It used to be a fifth pill ON the card, and
  // this test asserted only that the text EXISTED — which stayed green the whole time the
  // button was being painted outside its card and was physically unclickable. So it now
  // DRIVES the control instead of counting it. Reachability, not existence.
  it('sits beside the tax package, behind the card’s one control', async () => {
    grid('financials');
    // Exact name — the card is itself role="button" and a loose pattern matches it too.
    const open = await screen.findAllByRole('button', { name: 'Documents & filings' });
    expect(open).toHaveLength(2); // one per corporation
    fireEvent.click(open[0]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByRole('button', { name: /1099s/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Tax package/ })).toBeTruthy();
  });

  it('is absent from the Portfolio tab', async () => {
    grid('leases');
    // Exact name — the card is itself role="button" and a loose pattern matches it too.
    const open = await screen.findAllByRole('button', { name: 'Documents & filings' });
    fireEvent.click(open[0]);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).queryByRole('button', { name: /1099s/ })).toBeNull();
  });
});

describe('the list, and the question it asks', () => {
  // ⚠ THE ONE THAT MATTERS. Amlak must never decide whether a vendor is incorporated.
  it('asks for a W-9 rather than deciding the exemption itself', async () => {
    const dlg = await openModal();
    expect(dlg.textContent).toMatch(/do you have a W-9 for each/i);
    expect(dlg.textContent).toMatch(/can’t tell whether a vendor is incorporated/i);
    expect(dlg.textContent).toMatch(/worksheet, not a filing/i);
    // And it states the deadline that makes this its own control.
    expect(dlg.textContent).toMatch(/January 31/);
  });

  it('names the vendors above the threshold, biggest first', async () => {
    const dlg = await openModal();
    const names = [...dlg.querySelectorAll('.w9-row .w9-name strong')].map((n) => n.textContent);
    expect(names[0]).toBe('Landscaping');
    expect(names).toContain('Security');
    expect(names).toContain('Snow removal');
    expect(within(dlg).getByText('$8,000.00')).toBeTruthy();
    expect(dlg.textContent).toMatch(new RegExp(`Above \\$${thresholdFor(Y).toLocaleString('en-US')}`));
  });

  // ⚠ A bucket label is NOT a payee — "Repairs" can cover three contractors — so a
  // bucket-derived name says so on its own row AND in the flags.
  it('says when a name came from an expense bucket rather than a payee', async () => {
    const dlg = await openModal();
    expect(dlg.textContent).toMatch(/Expense bucket — not a payee/);
    expect(flagText(dlg)).toMatch(/named after an expense bucket, not a payee/);
  });

  // ⚠ The refusal that points the OPPOSITE way to round 11: an unknown category is a
  // question, so the vendor is listed rather than ruled out.
  it('lists what it could not rule out, and says why', async () => {
    const dlg = await openModal();
    expect(flagText(dlg)).toMatch(/no tax category/);
    expect(flagText(dlg)).toMatch(/rather than risk dropping one/);
  });

  // Seen on a real portfolio: with exactly ONE uncategorised bucket the flag read
  // "1 carry no tax category". The demo seed carries that single bucket (Security), so
  // this case is the singular one — the plural wording is pinned in the unit suite.
  it('counts vendors in the singular when there is only one', async () => {
    const dlg = await openModal();
    const t = flagText(dlg);
    expect(t).toMatch(/1 vendor carries no tax category/);
    expect(t).not.toMatch(/\b1 carry\b/);
    expect(t).not.toMatch(/\b1 have\b/);
    expect(t).not.toMatch(/\b1 of these are\b/);
  });

  // ⚠ Round 6's audit rows are forward-only, so "no method on record" must read as
  // UNKNOWN — never assumed to be a cheque, or a card payment lands on both forms.
  it('warns that a card payment is already on the processor’s 1099-K', async () => {
    const dlg = await openModal();
    expect(flagText(dlg)).toMatch(/no record of how (it was|they were) paid/);
    expect(flagText(dlg)).toMatch(/1099-K/);
  });

  // A flat un-itemized total has no payee attached to any part of it, so it cannot be
  // tested against the threshold at all. Silence would read as "nothing to report".
  it('reports the money it cannot attribute to anyone', async () => {
    const dlg = await openModal();
    expect(flagText(dlg)).toMatch(/\$25,000\.00 of expenses is entered as a single yearly figure/);
    expect(flagText(dlg)).toMatch(/can’t be tested against the threshold/);
  });

  it('says the smaller vendors are still on the sheet, not hidden by the threshold', async () => {
    const dlg = await openModal();
    expect(dlg.textContent).toMatch(/still listed on the sheet/);
  });
});

describe('the workbook itself', () => {
  // The only thing that proves both sheets actually build: drive the real button.
  it('builds a real workbook from the Download button', async () => {
    const blobs = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (b) => { blobs.push(b); return 'blob:test'; };
    URL.revokeObjectURL = () => {};
    try {
      const dlg = await openModal();
      fireEvent.click(within(dlg).getByRole('button', { name: /Download Excel/ }));
      await waitFor(() => expect(blobs).toHaveLength(1));
      expect(blobs[0].size).toBeGreaterThan(3000);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  }, 30000);
});
