// George, 2026-08-17: "theres no way to edit date paid or the names of the expense
// components."
//
// There genuinely wasn't — `cam_line_items` had an add and a delete and nothing between
// them, so fixing a typo meant deleting a real expense row and retyping it. On an imported
// line that also threw away the bank provenance.
//
// The two fields are deliberately the two that are NOT billed, which is why none of this
// carries an invoice rebuild — the assertions below pin that as hard as they pin the edit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CamSection from '../CamSection';
import { listCamLineItems, getExpenseRecord, upsertExpenseRecord, updateExpenseLineItem } from '../../lib/api';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const P = 'prop-1';
const SEED = { taxes_total: 25000, cam_total: 18000, roof_total: 4000 };

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}><CamSection propId={P} year={Y} expense={{ ...SEED }} /></QueryClientProvider>);
};

const rowFor = (name) => waitFor(() => {
  const el = screen.getByText(name);
  expect(el).toBeTruthy();
  return el.closest('.cam-row');
});

beforeEach(() => cleanup());
afterEach(async () => {
  // Put the seeded names and dates back, whatever a test did to them.
  await updateExpenseLineItem('cam-1', { label: 'Landscaping', paid_date: `${Y}-04-18` });
  await updateExpenseLineItem('cam-2', { label: 'Snow removal', paid_date: `${Y}-01-22` });
  await upsertExpenseRecord({ property_id: P, year: Y, ...SEED });
});

describe('Renaming an expense component', () => {
  it('commits what you type on Enter, and the row reads it back', async () => {
    wrap();
    const row = await rowFor('Landscaping');
    fireEvent.click(row.querySelector('.inline-edit'));
    const input = row.querySelector('.inline-edit-input');
    fireEvent.change(input, { target: { value: 'Grounds care' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Grounds care')).toBeTruthy());
    const [stored] = (await listCamLineItems(P, Y)).filter((it) => it.id === 'cam-1');
    expect(stored.label).toBe('Grounds care');
  });

  it('says which tax line the money just moved to — the thing a rename actually changes', async () => {
    wrap();
    const row = await rowFor('Snow removal');
    fireEvent.click(row.querySelector('.inline-edit'));
    const input = row.querySelector('.inline-edit-input');
    // "Snow removal" carries Amlak's default category; a name nobody has ever categorized
    // does not, and the strip has to say so rather than leaving it to the workbook.
    fireEvent.change(input, { target: { value: 'Parking lot sweeping' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText(/renamed Snow removal → Parking lot sweeping/)).toBeTruthy());
    expect(screen.getByText(/now files under/)).toBeTruthy();
  });

  it('does NOT move the CAM total — a name is not a figure', async () => {
    const before = (await getExpenseRecord(P, Y))?.cam_total;
    wrap();
    const row = await rowFor('Landscaping');
    fireEvent.click(row.querySelector('.inline-edit'));
    const input = row.querySelector('.inline-edit-input');
    fireEvent.change(input, { target: { value: 'Grounds care' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('Grounds care')).toBeTruthy());
    expect((await getExpenseRecord(P, Y))?.cam_total).toBe(before);
  });

  it('leaves the row alone on Escape, and writes nothing', async () => {
    wrap();
    const row = await rowFor('Landscaping');
    fireEvent.click(row.querySelector('.inline-edit'));
    const input = row.querySelector('.inline-edit-input');
    fireEvent.change(input, { target: { value: 'Nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());
    const [stored] = (await listCamLineItems(P, Y)).filter((it) => it.id === 'cam-1');
    expect(stored.label).toBe('Landscaping');
  });

  it('refuses an empty name rather than storing a nameless expense', async () => {
    await expect(updateExpenseLineItem('cam-1', { label: '   ' })).rejects.toThrow(/needs a name/);
  });
});

describe('The date paid', () => {
  it('can be set on a line that never had one', async () => {
    wrap();
    // "Security" is seeded with no paid_date at all — it reads "＋ date" until you click it.
    const row = await rowFor('Security');
    const cell = row.querySelector('.cam-date');
    expect(cell.textContent).toMatch(/date/);
    fireEvent.click(cell);
    const input = row.querySelector('.inline-edit-input');
    fireEvent.change(input, { target: { value: `${Y}-03-11` } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(async () => {
      const [stored] = (await listCamLineItems(P, Y)).filter((it) => it.id === 'cam-3');
      expect(stored.paid_date).toBe(`${Y}-03-11`);
    });
    await updateExpenseLineItem('cam-3', { paid_date: null });
  });

  it('does NOT move the CAM total either — it only decides which month the cost falls in', async () => {
    const before = (await getExpenseRecord(P, Y))?.cam_total;
    await updateExpenseLineItem('cam-1', { paid_date: `${Y}-09-09` });
    expect((await getExpenseRecord(P, Y))?.cam_total).toBe(before);
  });
});

describe('A line the service contract owns', () => {
  // prop-2 is where the demo's contract-derived CAM lines live (Arctic snow removal,
  // GreenScape landscaping — one row per contract, per year).
  const wrapProp2 = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return render(<QueryClientProvider client={qc}><CamSection propId="prop-2" year={Y} expense={{ ...SEED }} /></QueryClientProvider>);
  };

  it('is not renamable, because the contract rewrites its name on every year open', async () => {
    wrapProp2();
    const badge = await waitFor(() => {
      const el = screen.queryAllByText('from contract')[0];
      expect(el).toBeTruthy();
      return el;
    });
    const row = badge.closest('.cam-row');
    // A rename here would look accepted and be gone on the next page load, so there is
    // nothing to click — and the cell says where the name actually comes from.
    expect(row.querySelector('.cam-name .inline-edit')).toBeNull();
    const stat = row.querySelector('.cam-name .inline-edit-static');
    expect(stat).toBeTruthy();
    expect(stat.getAttribute('title')).toMatch(/rename it in Contracts/i);
  });

  it('still lets you date it — the contract says the cost, never the day it cleared', async () => {
    wrapProp2();
    const badge = await waitFor(() => {
      const el = screen.queryAllByText('from contract')[0];
      expect(el).toBeTruthy();
      return el;
    });
    expect(badge.closest('.cam-row').querySelector('.cam-date')).toBeTruthy();
  });
});
