// Render test for the Learned-payees manager (mounted in the real LedgerPage against
// the demo mock). Rules are created at runtime via saveImportRule (the mock db is
// shared per file, cleared before each test), then the panel lists THIS property's
// rules, retargets one in place (id preserved so an import's applied[].rule_id stays
// valid), and removes one behind the confirm gate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';
import LedgerPage from '../../pages/LedgerPage';
import { saveImportRule, listImportRules, deleteImportRule } from '../../lib/api';

function renderLedger(propId = 'prop-1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/financials/corp-1/${propId}/ledger`]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <Routes>
            <Route path="/financials/:corpId/:propId/ledger" element={<LedgerPage />} />
            <Route path="/financials/:corpId/:propId" element={<div>financials-page</div>} />
          </Routes>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

async function clearRules() {
  for (const r of await listImportRules()) await deleteImportRule(r.id);
}

beforeEach(async () => { cleanup(); await clearRules(); });
afterEach(async () => { await clearRules(); });

describe('LearnedPayeesPanel — the learned-payee manager', () => {
  it('lists this property\'s rules with target + account hint, and hides another property\'s rule', async () => {
    await saveImportRule({ property_id: 'prop-1', pattern: 'CITY DENTAL PC', target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••4821' });
    await saveImportRule({ property_id: 'prop-1', pattern: 'GREENLEAF LANDSCAPING', target_kind: 'expense_cam', cam_label: 'Landscaping' });
    await saveImportRule({ property_id: 'prop-2', pattern: 'SUNRISE VENDOR', target_kind: 'expense_tax' });

    renderLedger('prop-1');
    await waitFor(() => expect(screen.getByText(/Learned payees \(2\)/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Learned payees \(2\)/));

    // Both prop-1 rules show; the prop-2 rule does not.
    expect(screen.getByText('CITY DENTAL PC')).toBeTruthy();
    expect(screen.getByText('GREENLEAF LANDSCAPING')).toBeTruthy();
    expect(screen.queryByText('SUNRISE VENDOR')).toBeNull();

    // The account hint column shows the tenant rule's ••4821.
    expect(screen.getByText('••4821')).toBeTruthy();

    // The tenant rule's retarget select is set to City Dental (lease-2).
    const cityRow = screen.getByText('CITY DENTAL PC').closest('tr');
    expect(cityRow.querySelector('select').value).toBe('lease:lease-2');
  });

  it('retargets a rule in place and PRESERVES its id', async () => {
    const created = await saveImportRule({ property_id: 'prop-1', pattern: 'CITY DENTAL PC', target_kind: 'tenant', lease_id: 'lease-2', account_hint: '••4821' });
    renderLedger('prop-1');
    await waitFor(() => expect(screen.getByText(/Learned payees \(1\)/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Learned payees \(1\)/));

    const row = screen.getByText('CITY DENTAL PC').closest('tr');
    fireEvent.change(row.querySelector('select'), { target: { value: 'ignore' } });

    await waitFor(async () => {
      const r = (await listImportRules()).find((x) => x.pattern === 'CITY DENTAL PC');
      expect(r.target_kind).toBe('ignore');
    });
    const after = (await listImportRules()).find((x) => x.pattern === 'CITY DENTAL PC');
    expect(after.id).toBe(created.id); // same rule, updated in place
    expect(after.account_hint).toBe('••4821'); // hint carried through
  });

  it('removes a rule behind a confirm and drops the count', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await saveImportRule({ property_id: 'prop-1', pattern: 'CITY DENTAL PC', target_kind: 'tenant', lease_id: 'lease-2' });
    await saveImportRule({ property_id: 'prop-1', pattern: 'GREENLEAF LANDSCAPING', target_kind: 'expense_cam', cam_label: 'Landscaping' });

    renderLedger('prop-1');
    await waitFor(() => expect(screen.getByText(/Learned payees \(2\)/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Learned payees \(2\)/));

    const row = screen.getByText('GREENLEAF LANDSCAPING').closest('tr');
    fireEvent.click(within(row).getByText(/Remove/));

    await waitFor(() => expect(screen.getByText(/Learned payees \(1\)/)).toBeTruthy());
    expect(screen.queryByText('GREENLEAF LANDSCAPING')).toBeNull();
    expect(window.confirm).toHaveBeenCalled();
    window.confirm.mockRestore();
  });
});
