// The shared fold — one collapsible for every section on Financials and the tenant page
// (George, 2026-08-12: "can you make all the tabs on the financials page and individual
// tenant pages collapsible like we have for rent escalations?").
//
// Four things are load-bearing here, and only one of them is "the body hides":
//
//  1. IT REMEMBERS. A fold that forgets itself makes him re-close the same four sections
//     on every visit, which is worse than no fold. Asserted across a real unmount/remount.
//  2. ONLY WHAT HE TOUCHED IS STORED. A section he has never clicked must still follow the
//     default its caller passes — otherwise today's defaults are frozen into his browser
//     forever and changing one later reaches nobody.
//  3. A FOLDED PANEL STILL STATES WHAT IT HOLDS. The Financials sections carry real
//     figures in their folded line; a fold that hides its own summary just gets reopened.
//  4. LEASE TERMS DOES NOT FOLD. He asked for that section to be left alone, and "we
//     didn't add a toggle" is exactly the kind of omission a later round restores by
//     accident.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Panel from '../Panel';
import { isPanelOpen } from '../../lib/panelState';
import PropertyFinancialsPage from '../../pages/PropertyFinancialsPage';
import LeaseDetailPage from '../../pages/LeaseDetailPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { ConfirmProvider } from '../ConfirmDialog';
import { currentYear } from '../../lib/format';

const Y = currentYear();
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

// ⚠ THIS SUITE'S JSDOM HAS NO localStorage AT ALL (node's experimental one needs
// --localstorage-file, so `typeof localStorage === 'undefined'` here) — the same finding
// announcements.test.js records. `panelState` copes, because every read and write sits in
// a try/catch and a bare undefined identifier throws a ReferenceError like any other. But
// "it remembers" is precisely what needs covering, so stand up a minimal in-memory one.
// Scoped to this file; vitest isolates per test file.
//
// It also means the app is exercised BOTH ways: this file with storage, every other page
// test without it — which is the free proof that a missing localStorage degrades to "every
// section at its default" rather than to a white screen.
beforeAll(() => {
  if (typeof globalThis.localStorage === 'undefined') {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
});

beforeEach(() => { cleanup(); localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

// ── The component on its own ──────────────────────────────────────────────────────────

describe('Panel', () => {
  const sample = (props = {}) => (
    <Panel id="test.one" title="A section" hint="what it is" summary="what it holds" {...props}>
      <p>the body</p>
    </Panel>
  );
  const toggle = () => screen.getByRole('button', { name: /A section/ });

  it('opens expanded, folds away on click, and swaps its note for the summary', () => {
    render(sample());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('the body')).toBeTruthy();
    expect(screen.getByText('what it is')).toBeTruthy();

    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('the body')).toBeNull();
    // ⚠ The summary is the point. A folded panel that says only its title has hidden the
    // figure the landlord opened it for.
    expect(screen.getByText('what it holds')).toBeTruthy();
    expect(screen.queryByText('what it is')).toBeNull();
  });

  it('remembers the fold across a full unmount and remount', () => {
    render(sample());
    fireEvent.click(toggle());
    expect(isPanelOpen('test.one', true)).toBe(false);

    cleanup();
    render(sample());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('the body')).toBeNull();
  });

  it('leaves a section he never touched at its default', () => {
    render(sample());
    fireEvent.click(toggle());          // stores test.one = false
    cleanup();

    // A DIFFERENT section, defaulting shut, is unaffected by the stored one — and a
    // default of `false` is honoured even though nothing about it was ever saved.
    render(sample({ id: 'test.two', defaultOpen: false }));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    cleanup();
    render(sample({ id: 'test.three' }));
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('survives a localStorage that throws or holds junk', () => {
    localStorage.setItem('amlak.panels', '{not json');
    render(sample());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    cleanup();

    // Safari in private mode throws on setItem. Folding must still work for the session.
    const spy = vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded'); });
    render(sample());
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    spy.mockRestore();
  });

  it('keeps its actions out of the toggle — a button inside a button is invalid', () => {
    render(sample({ actions: <button type="button">Do a thing</button> }));
    const action = screen.getByRole('button', { name: 'Do a thing' });
    expect(action.closest('.panel-toggle')).toBeNull();
    // …and it still works while the section is folded.
    fireEvent.click(toggle());
    expect(screen.getByRole('button', { name: 'Do a thing' })).toBeTruthy();
  });
});

// ── The real Financials page ──────────────────────────────────────────────────────────

function renderFinancials() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={['/financials/corp-1/prop-1']}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/financials/:corpId/:propId" element={<PropertyFinancialsPage />} />
            </Routes>
          </ConfirmProvider>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('Financials — every section folds, and says what it holds', () => {
  it('folds Expense entry away and states the three totals in its place', async () => {
    renderFinancials();
    const head = () => screen.getByRole('button', { name: /Expense entry/ });
    await waitFor(() => expect(head()).toBeTruthy());
    // The three itemized blocks prove the section is really rendered.
    await waitFor(() => expect(screen.getByRole('button', { name: /Property taxes — itemized/ })).toBeTruthy());

    fireEvent.click(head());
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /Property taxes — itemized/ })).toBeNull();
    // Demo seed: $25,000 taxes · $18,950 CAM (roof is off on this property).
    await waitFor(() => expect(screen.getByText(/Taxes \$25,000\.00 · CAM \$/)).toBeTruthy());
  });

  it('folds the itemized blocks on their own, without folding their parent', async () => {
    renderFinancials();
    const taxes = () => screen.getByRole('button', { name: /Property taxes — itemized/ });
    await waitFor(() => expect(taxes()).toBeTruthy());
    fireEvent.click(taxes());
    expect(taxes().getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(screen.getByText(/\$25,000\.00 for the year/)).toBeTruthy());
    // Its parent and its sibling are untouched.
    expect(screen.getByRole('button', { name: /Expense entry/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /CAM \/ maintenance — itemized/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('states the net cost while "What it cost you" is shut', async () => {
    renderFinancials();
    const head = () => screen.getByRole('button', { name: /What it cost you/ });
    await waitFor(() => expect(head()).toBeTruthy());
    fireEvent.click(head());
    // The same three figures the open table totals to — folding must not cost them.
    await waitFor(() => expect(
      screen.getByText(/Spent \$49,950\.00 · recovered \$44,600\.00 · your net cost \$5,350\.00/)
    ).toBeTruthy());
  });

  it('names the tenants and the money behind the per-tenant breakdown', async () => {
    renderFinancials();
    const head = () => screen.getByRole('button', { name: /Per-tenant breakdown/ });
    await waitFor(() => expect(head()).toBeTruthy());
    fireEvent.click(head());
    await waitFor(() => expect(screen.getByText(/2 tenants · \$[\d,]+\.\d\d of CAM & taxes allocated/)).toBeTruthy());
  });

  it('leaves the Performance and Recoverable stat strips alone', async () => {
    renderFinancials();
    await waitFor(() => expect(screen.getByText(`Performance · FY ${Y}`)).toBeTruthy());
    // They are one row each and they are the headline figures — no toggle by design.
    expect(screen.queryByRole('button', { name: /Performance · FY/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Recoverable expenses/ })).toBeNull();
  });
});

// ── The real tenant page ──────────────────────────────────────────────────────────────

const LEASE = '/leases/corp-1/prop-1/lease-1';

function renderLease(path = LEASE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <ConfirmProvider>
            <Routes>
              <Route path="/leases/:corpId/:propId/:leaseId" element={<LeaseDetailPage />} />
            </Routes>
          </ConfirmProvider>
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

describe('Tenant page — the sections fold, except the one he asked to leave', () => {
  it('gives Lease terms no toggle at all', async () => {
    renderLease();
    await waitFor(() => expect(screen.getByText('Lease terms')).toBeTruthy());
    // ⚠ George: "no need to have one for the lease terms". The heading is there; the
    // button around it is not, and must not come back.
    expect(screen.queryByRole('button', { name: /Lease terms/ })).toBeNull();
    // Its neighbours do fold, which proves this test can tell the difference.
    expect(screen.getByRole('button', { name: /Rent escalations/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Renewal options/ })).toBeTruthy();
  });

  it('folds Renewal options and puts a real summary where the description was', async () => {
    renderLease();
    const head = () => screen.getByRole('button', { name: /Renewal options/ });
    await waitFor(() => expect(head()).toBeTruthy());
    expect(head().textContent).toContain('Notice-by = deadline');

    fireEvent.click(head());
    expect(head().getAttribute('aria-expanded')).toBe('false');
    // The description goes; something that states what the section HOLDS takes its place.
    expect(head().textContent).not.toContain('Notice-by = deadline');
    const note = head().querySelector('.panel-note');
    expect(note?.textContent.trim()).toMatch(/option|None recorded|Marked: no renewal option/);
  });

  it('forces a folded Renewal options open when an alert deep-links to it', async () => {
    // ⚠ THE ONE THAT BREAKS QUIETLY. `?focus=renewal` scrolls to this panel and flashes
    // it; landing on a closed lid flashes an empty box. The fold is REMEMBERED now, so a
    // panel he shut last week is exactly the state the alert has to overcome.
    renderLease();
    await waitFor(() => expect(screen.getByRole('button', { name: /Renewal options/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Renewal options/ }));
    expect(screen.getByRole('button', { name: /Renewal options/ }).getAttribute('aria-expanded')).toBe('false');

    cleanup();
    renderLease(`${LEASE}?focus=renewal`);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Renewal options/ }).getAttribute('aria-expanded')).toBe('true'));
  });

  it('forces a folded Insurance panel open the same way', async () => {
    renderLease();
    await waitFor(() => expect(screen.getByRole('button', { name: /Insurance/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Insurance/ }));
    expect(screen.getByRole('button', { name: /Insurance/ }).getAttribute('aria-expanded')).toBe('false');

    cleanup();
    renderLease(`${LEASE}?focus=insurance`);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Insurance/ }).getAttribute('aria-expanded')).toBe('true'));
  });

  it('keeps the Tenant statement shut by default, as it always has been', async () => {
    renderLease();
    await waitFor(() => expect(screen.getByRole('button', { name: /Tenant statement/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /Tenant statement/ }).getAttribute('aria-expanded')).toBe('false');
  });
});
