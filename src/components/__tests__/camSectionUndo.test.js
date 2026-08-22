// Render test for the Financials expense-entry ↩ Undo strips: removing a CAM line
// item offers a one-click Undo that puts the line back and re-syncs the CAM total.
// Mounts the REAL CamSection against the demo mock (DEMO mode forced by the test
// env). Seed: prop-1 current year has Landscaping 8,000 + Snow removal 4,000 +
// Security 6,000 → cam_total 18,000 (exp-1).
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CamSection from '../CamSection';
import { listCamLineItems, deleteCamLineItem, getExpenseRecord, upsertExpenseRecord } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();

describe('CamSection — remove a line item, then Undo restores it', () => {
  it('✕ removes Landscaping (total re-syncs), ↩ Undo brings it back (total re-syncs again)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CamSection propId="prop-1" year={Y} expense={{ taxes_total: 25000, cam_total: 18000, roof_total: 4000 }} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());

    // Remove it via the row's own ✕ (each row has one — scope to the right row).
    const row = screen.getByText('Landscaping').closest('.cam-row');
    fireEvent.click(within(row).getByText('✕'));
    await waitFor(() => expect(screen.queryByText('Landscaping')).toBeNull());
    expect(screen.getByText('removed Landscaping')).toBeTruthy();
    expect((await getExpenseRecord('prop-1', Y)).cam_total).toBe(10000); // 18,000 − 8,000

    // One click puts it back — the line returns and the CAM total re-syncs.
    fireEvent.click(screen.getByRole('button', { name: '↩ Undo' }));
    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());
    const items = await listCamLineItems('prop-1', Y);
    const restored = items.find((it) => it.label === 'Landscaping');
    expect(restored).toBeTruthy();
    expect(Number(restored.amount)).toBe(8000);
    expect((await getExpenseRecord('prop-1', Y)).cam_total).toBe(18000);
  });
});

// ⚠ THE FLAT PATH, which had no test at all and was the one that was broken. `saveFlat.mutate()`
// was called with NO argument, so the `prevCam` react-query hands to `onSuccess(_data, prevCam)`
// was `undefined` and the undo wrote `Number(undefined) || 0` — i.e. $0 — and then rebuilt every
// stored invoice for the year at no CAM. Its two sibling copies (TaxSection, RoofSection) both
// pass the previous figure correctly; this one didn't, and only a flat-entry property could
// reach it, which is why nothing caught it.
describe('CamSection — the FLAT CAM undo restores the previous figure, not $0', () => {
  it('save 45,000 then ↩ Undo puts 40,000 back', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The flat form only appears when the property has NO line items — clear prop-2's.
    const existing = await listCamLineItems('prop-2', Y);
    for (const it of existing) await deleteCamLineItem(it.id, 'prop-2', Y);
    await upsertExpenseRecord({ property_id: 'prop-2', year: Y, taxes_total: 0, cam_total: 40000, roof_total: 0 });

    render(
      <QueryClientProvider client={qc}>
        <CamSection propId="prop-2" year={Y} expense={{ taxes_total: 0, cam_total: 40000, roof_total: 0 }} />
      </QueryClientProvider>
    );
    const box = await screen.findByPlaceholderText('40000');
    fireEvent.change(box, { target: { value: '45000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save flat CAM' }));

    await waitFor(async () => expect((await getExpenseRecord('prop-2', Y)).cam_total).toBe(45000));
    expect(screen.getByText('flat CAM saved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '↩ Undo' }));
    await waitFor(async () => expect((await getExpenseRecord('prop-2', Y)).cam_total).toBe(40000));
  });
});
