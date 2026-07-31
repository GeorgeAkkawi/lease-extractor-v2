// The size-change effect card, driven through the REAL AddendumEditor against the demo
// mock — the same paste → review → save path a landlord uses.
//
// The pure carry-through is pinned in lib/__tests__/premisesResize.test.js. What only the
// component can show is the judgement call in front of it: the card is ticked when the
// rider genuinely re-sizes the premises and left alone when it merely recites the size
// already on file. That distinction is the whole reason this is a review card and not an
// automatic write.
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AddendumEditor from '../AddendumEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import {
  createCorporation, createProperty, createLease, getLease, listAddendums,
} from '../../lib/api';

// The canned rider surrenders space, reducing the premises to 1,600 SF.
const RIDER_SF = 1600;

async function freshLease(square_footage) {
  const corp = await createCorporation('Resize Review Holdings');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Resize Review Plaza', address: '1 Review St', building_sf: 10000 });
  return createLease({
    property_id: prop.id, tenant_name: 'Review Tenant LLC', square_footage,
    base_rent: 120000, lease_start: '2020-01-01', lease_termination_date: '2028-12-31',
  });
}

function mount(leaseId, squareFootage) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <AddendumEditor leaseId={leaseId} leaseInactive={false} squareFootage={squareFootage} currentTermEnd="2028-12-31" />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

async function extractCanned() {
  fireEvent.click(await screen.findByRole('button', { name: /Add addendum \/ rider/i }));
  fireEvent.click(await screen.findByRole('button', { name: /Paste text instead/i }));
  fireEvent.change(screen.getByPlaceholderText(/Paste the addendum/i), { target: { value: 'FIRST AMENDMENT…' } });
  fireEvent.click(screen.getByRole('button', { name: /Extract with AI/i }));
  await waitFor(() => expect(screen.getByText(/Here's what the AI read/i)).toBeTruthy());
}

// This card, found via its title so it can't be confused with the five other effect
// cards on the same screen. EffectCard renders each as a `.callout` whose body exists
// only while the card is ticked.
const sizeCard = () => screen.getByText('Changes the size of the premises').closest('.callout');
const sizeToggle = () => sizeCard().querySelector('input[type="checkbox"]');

describe('The size-change card', () => {
  it('is ticked and filled when the rider re-sizes the premises', async () => {
    cleanup();
    const lease = await freshLease(4000);
    mount(lease.id, 4000);
    await extractCanned();

    expect(sizeToggle().checked).toBe(true);
    expect(screen.getByDisplayValue(String(RIDER_SF))).toBeTruthy();
    // It quotes the clause, and says what the lease carries today.
    expect(sizeCard().textContent).toMatch(/reducing the Premises to 1,600 rentable square feet/);
    expect(screen.getByText(/Currently 4,000 SF on this lease/)).toBeTruthy();
    // …and is honest that the whole year re-splits, not just the months after the rider.
    expect(sizeCard().textContent).toMatch(/whole year/i);
  });

  it('stays UNTICKED when the rider only recites the size already on file', async () => {
    cleanup();
    // A lease already at the rider's figure — so it reads as a recital, not a change.
    const lease = await freshLease(RIDER_SF);
    mount(lease.id, RIDER_SF);
    await extractCanned();

    expect(sizeToggle().checked).toBe(false);
    // Nothing is hidden, though — the figure was read and kept, so ticking the card
    // yourself shows it rather than an empty box.
    fireEvent.click(sizeToggle());
    expect(sizeCard().querySelector('input[type="number"]').value).toBe(String(RIDER_SF));
  });

  it('writes the new size on save, and only then', async () => {
    cleanup();
    const lease = await freshLease(4000);
    mount(lease.id, 4000);
    await extractCanned();

    // Nothing has moved while the review is open.
    expect(Number((await getLease(lease.id)).square_footage)).toBe(4000);

    fireEvent.click(screen.getByRole('button', { name: /Save & apply/i }));
    await waitFor(async () => expect(await listAddendums(lease.id)).toHaveLength(1));
    await waitFor(async () => expect(Number((await getLease(lease.id)).square_footage)).toBe(RIDER_SF));
  });

  it('leaves the size alone when the landlord unticks the card', async () => {
    cleanup();
    const lease = await freshLease(4000);
    mount(lease.id, 4000);
    await extractCanned();

    fireEvent.click(sizeToggle());
    expect(sizeToggle().checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Save & apply/i }));
    await waitFor(async () => expect(await listAddendums(lease.id)).toHaveLength(1));
    // The rider still applied its other effects; the premises did not move.
    expect(Number((await getLease(lease.id)).square_footage)).toBe(4000);
  });
});
