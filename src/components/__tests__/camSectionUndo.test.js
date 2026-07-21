// Render test for the Financials expense-entry ↩ Undo strips: removing a CAM line
// item offers a one-click Undo that puts the line back and re-syncs the CAM total.
// Mounts the REAL CamSection against the demo mock (DEMO mode forced by the test
// env). Seed: prop-1 current year has Landscaping 8,000 + Snow removal 4,000 +
// Security 6,000 → cam_total 18,000 (exp-1).
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CamSection from '../CamSection';
import { listCamLineItems, getExpenseRecord } from '../../lib/api';
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
