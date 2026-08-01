// Slice 5b in the DOM — the control that moves a bill, and the two places it refuses to
// appear. Mounts the REAL RoofSection and the REAL asset panel against the demo mock.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import RoofSection from '../RoofSection';
import AssetRegisterSection from '../AssetRegisterSection';
import { addRoofLineItem, upsertExpenseRecord, getExpenseRecord } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const PROP = 'prop-2';         // open years
const CLOSED_PROP = 'prop-1';  // the demo seed closes its current year

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

let nextYear = Y + 30;
const scratch = async () => {
  const y = nextYear;
  nextYear += 2;
  await upsertExpenseRecord({ property_id: PROP, year: y, taxes_total: 0, cam_total: 0, roof_total: 0 });
  return y;
};

beforeEach(() => cleanup());

describe('capitalizing from the expense line it is sitting in', () => {
  it('offers the control above the de-minimis floor and withholds it below', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });
    // Under $2,500 a repair is a repair — offering the choice on every filter change
    // would be noise on every statement.
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Gutter clean', amount: 400, paid_date: `${y}-02-01` });

    withProviders(<RoofSection propId={PROP} year={y} />);
    await waitFor(() => expect(screen.getByText('Roof replacement')).toBeTruthy());

    const rowOf = (t) => [...document.querySelectorAll('.cam-row')].find((r) => r.textContent.includes(t));
    expect(within(rowOf('Roof replacement')).getByText('⤴ Capitalize')).toBeTruthy();
    expect(within(rowOf('Gutter clean')).queryByText('⤴ Capitalize')).toBeNull();
  });

  it('names what it will do to the bill before doing it, then does it', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });

    withProviders(<RoofSection propId={PROP} year={y} />);
    await waitFor(() => expect(screen.getByText('⤴ Capitalize')).toBeTruthy());
    fireEvent.click(screen.getByText('⤴ Capitalize'));

    // The form opens on the line's own date — never invented — and on the roof's life.
    expect(screen.getByPlaceholderText('Life — 39 yr')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Capitalize' }));
    // ⚠ THE CONSEQUENCE, NAMED IN THE DIRECTION IT ACTUALLY CUTS, before anything moves.
    await waitFor(() => expect(screen.getByText(/Capitalize this cost\?/)).toBeTruthy());
    expect(document.body.textContent).toMatch(/roof total drops by \$19,500\.00/);
    expect(document.body.textContent).toMatch(/responsible for the roof is billed less/);

    // Scoped to the dialog: the form's own button carries the same word, and the whole
    // point of the dialog is that IT is the thing that commits.
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Capitalize' }));
    await waitFor(async () => {
      expect(Number((await getExpenseRecord(PROP, y))?.roof_total) || 0).toBe(0);
    });
  });

  // ⚠ The refusal, surfaced where the landlord is standing rather than failing silently.
  it('explains itself instead of acting when the year is closed', async () => {
    withProviders(<RoofSection propId={CLOSED_PROP} year={Y} />);
    await waitFor(() => expect(screen.getByText(/Apex Roofing — section replacement/)).toBeTruthy());

    const before = Number((await getExpenseRecord(CLOSED_PROP, Y))?.roof_total) || 0;
    fireEvent.click(screen.getByText('⤴ Capitalize'));
    fireEvent.click(screen.getByRole('button', { name: 'Capitalize' }));
    await waitFor(() => expect(screen.getByText(/Capitalize this cost\?/)).toBeTruthy());
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Capitalize' }));

    await waitFor(() => expect(screen.getByText(/fiscal year is closed/)).toBeTruthy());
    expect(Number((await getExpenseRecord(CLOSED_PROP, Y))?.roof_total) || 0).toBe(before);
  });
});

describe('billing a capitalized cost back, from the asset register', () => {
  it('offers both charges rather than guessing which one, and says who pays each', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Roof replacement')).toBeTruthy());

    const row = [...document.querySelectorAll('.asset-row')].find((r) => r.textContent.includes('Roof replacement'));
    // ⚠ "Building improvement" covers a roof AND a lobby, and only one of those bills to
    // roof-responsible tenants — so the choice is offered, never inferred from the kind.
    expect(within(row).getByText('Bill through CAM')).toBeTruthy();
    expect(within(row).getByText('…or roof')).toBeTruthy();
    expect(within(row).getByText('Not billed back.')).toBeTruthy();
  });

  it('never offers to bill the building itself back to tenants', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Maple Plaza — structure')).toBeTruthy());

    const row = [...document.querySelectorAll('.asset-row')].find((r) => r.textContent.includes('Maple Plaza — structure'));
    // A tenant pays for improvements to the property, not for the landlord owning it.
    expect(within(row).queryByText('Bill through CAM')).toBeNull();
    expect(within(row).queryByText('…or roof')).toBeNull();
  });

  it('states the lease limit Amlak cannot check, at the moment of the decision', async () => {
    withProviders(<AssetRegisterSection propId="prop-1" year={Y} />);
    await waitFor(() => expect(screen.getByText('Roof replacement')).toBeTruthy());

    const row = [...document.querySelectorAll('.asset-row')].find((r) => r.textContent.includes('Roof replacement'));
    fireEvent.click(within(row).getByText('…or roof'));
    await waitFor(() => expect(screen.getByText(/Bill this back to tenants\?/)).toBeTruthy());
    expect(document.body.textContent).toMatch(/only leases whose terms make them responsible for the roof/);
    expect(document.body.textContent).toMatch(/can’t tell whether your leases permit recovering capital costs/);
  });
});
