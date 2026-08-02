// Round 15 — the corporation card's controls, and the bug that made three of them
// unclickable.
//
// ⚠ WHAT WENT WRONG AND WHY NO TEST CAUGHT IT. Rounds 12–14 each added a pill to the card
// until there were five. `.corp-actions` carried `flex-shrink:0`, so as a flex item it
// claimed its full max-content width (measured: 617px inside a 320px card) and its own
// `flex-wrap` never fired — the last three buttons were painted OUTSIDE the card, on top
// of the NEXT one, which then received the clicks. So "Tax package" on any card that
// wasn't last in its row silently did nothing, and it read as a broken download.
//
// Every existing test asserted the pill EXISTED (`toHaveLength(2)`), which passes happily
// while it is unreachable. Existence is not reachability. So the assertions here are about
// the CONTROL BEING FINDABLE AND ITS HANDLER FIRING, and about there being exactly one of
// them per card — the property that makes overflow impossible in the first place.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CorporationsPage from '../../pages/CorporationsPage';
import { ChromeProvider } from '../../context/ChromeContext';

const withProviders = (ui, path) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={qc}>
        <ChromeProvider>{ui}</ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
};

const grid = async (mode) => {
  withProviders(
    <Routes><Route path={`/${mode}`} element={<CorporationsPage mode={mode} />} /></Routes>,
    `/${mode}`
  );
  await screen.findByText('Acme Holdings');
};

/** Open the panel on the FIRST card — the one whose spill used to be covered. */
const openPanel = async (mode = 'financials') => {
  await grid(mode);
  // Exact name, not a regex: the CARD is itself role="button", so its accessible name
  // (the whole card's text) would match a loose pattern and the click would navigate.
  const btns = screen.getAllByRole('button', { name: 'Documents & filings' });
  fireEvent.click(btns[0]);
  return await screen.findByRole('dialog');
};

beforeEach(() => cleanup());

describe('the card carries exactly one control', () => {
  // The structural property. Five controls could overflow; one cannot.
  it('renders a single action per card, on both tabs', async () => {
    await grid('financials');
    const cards = document.querySelectorAll('.corp-card');
    expect(cards.length).toBeGreaterThan(1);
    for (const card of cards) {
      expect(card.querySelectorAll('.corp-actions')).toHaveLength(1);
      expect(card.querySelectorAll('.corp-edit')).toHaveLength(1);
    }
    cleanup();
    await grid('leases');
    for (const card of document.querySelectorAll('.corp-card')) {
      expect(card.querySelectorAll('.corp-edit')).toHaveLength(1);
    }
  });

  // The names that used to sit on the card are gone FROM the card — if one comes back as
  // a sixth pill, the overflow comes back with it.
  it('no longer paints the five names onto the card itself', async () => {
    await grid('financials');
    for (const name of ['Business profile', 'Annual report', 'Tax package', '1099s', 'Lender package']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });
});

describe('the panel reaches every one of them', () => {
  // ⚠ The regression that matters: driving the FIRST card, not the last. Under the old
  // markup this click landed on the neighbouring card and nothing opened.
  it('opens from the first card and lists all five', async () => {
    const dlg = await openPanel('financials');
    for (const name of ['Business profile', 'Annual report', 'Tax package', '1099s', 'Lender package']) {
      expect(within(dlg).getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
  });

  // Five bare nouns say nothing about who they are for. Every row states it.
  it('says in plain words what each one is', async () => {
    const dlg = await openPanel('financials');
    expect(dlg.textContent).toMatch(/For your accountant/i);
    expect(dlg.textContent).toMatch(/Due January 31/i);
    expect(dlg.textContent).toMatch(/when you apply for a loan or refinance/i);
    expect(dlg.textContent).toMatch(/appear on letters you send/i);
    // Grouped: what the company needs on file, vs what you hand someone.
    expect(dlg.textContent).toMatch(/The company/i);
    expect(dlg.textContent).toMatch(/Things you hand someone/i);
  });

  // The three exports need a fiscal year in scope, which the Portfolio tab has not.
  it('offers only the company rows on the Portfolio tab', async () => {
    const dlg = await openPanel('leases');
    expect(within(dlg).getByRole('button', { name: /Business profile/ })).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: /Annual report/ })).toBeTruthy();
    expect(within(dlg).queryByRole('button', { name: /Tax package/ })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: /Lender package/ })).toBeNull();
    expect(dlg.textContent).not.toMatch(/Things you hand someone/i);
  });

  // Picking a row hands off to the modal that already existed, and closes itself — so
  // exactly one dialog is ever open.
  it('hands off to the tax package, and only one dialog is open', async () => {
    const dlg = await openPanel('financials');
    fireEvent.click(within(dlg).getByRole('button', { name: /Tax package/ }));
    await waitFor(() => expect(screen.getByText(/Tax package ·/i)).toBeTruthy());
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByText('Things you hand someone')).toBeNull();
  });

  it('hands off to the 1099 worksheet', async () => {
    const dlg = await openPanel('financials');
    fireEvent.click(within(dlg).getByRole('button', { name: /1099s/ }));
    await waitFor(() => expect(screen.getByText(/Above \$/)).toBeTruthy());
  });

  it('closes on Escape without opening anything', async () => {
    const dlg = await openPanel('financials');
    fireEvent.keyDown(dlg, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
