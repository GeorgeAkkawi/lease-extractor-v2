// Slice 5c in the DOM. Mounts the REAL asset panel and drives the actual read → review
// → save flow against the demo mock's canned settlement statement.
//
// The assertion that matters is not "did it fill the fields" — it is that the screen
// SHOWS what it refused to capitalize. Without that list a landlord cannot tell a
// careful read from one that quietly dropped thirty lines.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import AssetRegisterSection from '../AssetRegisterSection';
import { listFixedAssets, deleteFixedAsset } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const PROP = 'prop-2';
// Deliberately not the seeded property's own name: the canned read proposes
// "{name} — structure", and prop-2 already owns an "Oak Center — structure".
const NAME = 'Harbourside Works';

const withProviders = (ui) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

// ⚠ An asset is deliberately NOT year-scoped (round 9), so one left behind by a case
// follows every later case into every year. Clear anything this suite created.
const seeded = new Set(['asset-1', 'asset-2', 'asset-3', 'asset-4']);
async function clearCreated() {
  for (const a of await listFixedAssets(PROP)) {
    if (!seeded.has(a.id)) await deleteFixedAsset(a.id);
  }
}

beforeEach(() => cleanup());
afterEach(clearCreated);

// Open the panel's modal and run the canned read through it.
async function readStatement() {
  withProviders(<AssetRegisterSection propId={PROP} year={Y} propertyName={NAME} />);
  fireEvent.click(await screen.findByText('⬆ Read a closing statement'));
  fireEvent.click(await screen.findByText('Paste text'));
  fireEvent.change(screen.getByPlaceholderText(/Paste the settlement statement text/), {
    target: { value: 'ALTA Settlement Statement' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
  await waitFor(() => expect(screen.getByText('What this becomes')).toBeTruthy());
  return screen.getByRole('dialog');
}

describe('reading a closing statement', () => {
  it('offers the read from the panel the assets land in', async () => {
    withProviders(<AssetRegisterSection propId={PROP} year={Y} propertyName={NAME} />);
    expect(await screen.findByText('⬆ Read a closing statement')).toBeTruthy();
  });

  it('proposes the building, its closing costs and the loan costs — and keeps them apart', async () => {
    const dlg = await readStatement();
    expect(within(dlg).getByText(`${NAME} — structure`)).toBeTruthy();
    expect(within(dlg).getByText('Closing costs capitalized into the purchase')).toBeTruthy();
    expect(within(dlg).getByText('Loan points and origination fees')).toBeTruthy();

    const costs = [...dlg.querySelectorAll('.cs-asset input[type="number"]')].map((i) => i.value);
    // Purchase price, the five capitalizable charges, and the two that buy the loan —
    // each in its own row rather than one summed figure.
    expect(costs).toContain('1450000');
    expect(costs).toContain('10711');
    expect(costs).toContain('11575');
  });

  // ⚠ THE ONE THAT MAKES THE LIST ABOVE TRUSTWORTHY.
  it('shows what it refused to capitalize, with the figure and where it belongs', async () => {
    const dlg = await readStatement();
    // The heading emphasises the "not", so its text spans nodes — match the element.
    const heads = [...dlg.querySelectorAll('.fin-subhead')].map((h) => h.textContent);
    expect(heads.some((h) => /What it does not become/.test(h))).toBe(true);
    // $50,706.67 of prorated taxes, prepaid insurance, transferred deposits, rent
    // proration and escrow — every dollar of which the naive read would capitalize.
    expect(dlg.textContent).toMatch(/\$50,706\.67/);
    expect(dlg.textContent).toMatch(/operating costs of the year/);
    expect(dlg.textContent).toMatch(/without buying anything/);
    expect(dlg.textContent).toMatch(/Tenant security deposits transferred/);
  });

  it('says outright that none of the excluded money is recorded anywhere', async () => {
    const dlg = await readStatement();
    // Writing a prorated tax into the year's total would re-split every tenant's share
    // on a year that is very likely closed. Reading a document is not a reason to move
    // somebody's rent.
    expect(dlg.textContent).toMatch(/None of these are recorded anywhere/);
    expect(dlg.textContent).toMatch(/12 charges read · 12 placed/);
  });

  it('flags the land it could not know, rather than splitting the price by a rule of thumb', async () => {
    const dlg = await readStatement();
    expect(dlg.textContent).toMatch(/land value isn’t on this document/);
  });

  it('says the loan costs have no life yet instead of borrowing the building’s', async () => {
    const dlg = await readStatement();
    expect(dlg.textContent).toMatch(/points amortize over your loan’s term/);
  });
});

describe('confirming the read', () => {
  it('writes exactly the three proposed assets, and they appear on the panel', async () => {
    const dlg = await readStatement();
    const before = (await listFixedAssets(PROP)).length;

    fireEvent.click(within(dlg).getByRole('button', { name: 'Record 3 assets' }));

    await waitFor(async () => {
      expect((await listFixedAssets(PROP)).length).toBe(before + 3);
    });

    const written = (await listFixedAssets(PROP)).filter((a) => !seeded.has(a.id));
    const building = written.find((a) => a.kind === 'building');
    expect(building.cost).toBe(1450000);
    expect(building.placed_in_service).toBe('2019-06-14');
    // Round 9's refusal, carried through the write: unanswered stays null, never 0.
    expect(building.land_cost).toBeNull();
    expect(written.find((a) => a.kind === 'loan_costs').useful_life_years).toBeNull();

    await waitFor(() => expect(screen.getByText(`${NAME} — structure`)).toBeTruthy());
  });

  it('writes nothing when the read is cancelled', async () => {
    const dlg = await readStatement();
    const before = (await listFixedAssets(PROP)).length;
    fireEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('What this becomes')).toBeNull());
    expect((await listFixedAssets(PROP)).length).toBe(before);
  });
});
