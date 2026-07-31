// Adding a renewal option — driven through the real RenewalOptionsEditor and the real
// dialog against the demo mock.
//
// George, 2026-07-30: "take out all the boxes for adding an option and only have them
// appear when the add option button is clicked … it needs to be a bit more in depth like
// if the rent goes up yearly … 'add rent escalation as part of this option' … lastly
// clean up the format of the renewal decision - the renew not renewing email tenant is
// not symmetrical."
//
// Three things are asserted here that a helper test can't see: the fields are GONE from
// the panel until asked for, the dialog's per-year dates are the dates that get written,
// and every row's decision buttons occupy the same two columns.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RenewalOptionsEditor from '../RenewalOptionsEditor';
import { ConfirmProvider } from '../ConfirmDialog';
import { listRenewals } from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';

// Bright Coffee — no seeded options, so anything the dialog creates is ours.
const LEASE = { id: 'lease-1', property_id: 'prop-1', tenant_name: 'Bright Coffee Co.', base_rent: 60000, lease_start: '2024-01-01', lease_termination_date: '2027-12-31' };

function renderEditor(lease = LEASE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <RenewalOptionsEditor leaseId={lease.id} lease={lease} escalations={[]} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

const openDialog = async () => {
  fireEvent.click(await screen.findByRole('button', { name: '+ Add option' }));
  return screen.findByRole('dialog', { name: 'Add a renewal option' });
};

beforeEach(() => cleanup());
afterEach(async () => {
  for (const o of await listRenewals('lease-1')) await supabase.from('renewal_options').delete().eq('id', o.id);
});

describe('The add-option fields live in the dialog, not on the panel', () => {
  it('shows one button and no input boxes until it is clicked', async () => {
    const { container } = renderEditor();
    await screen.findByRole('button', { name: '+ Add option' });
    // The old inline strip put six of these under the table, permanently.
    expect(container.querySelectorAll('input')).toHaveLength(0);

    await openDialog();
    expect(screen.getByLabelText).toBeTruthy();
    expect(document.querySelectorAll('.modal input').length).toBeGreaterThan(2);
  });

  it('refuses to save until it knows the term and the rent', async () => {
    renderEditor();
    const dlg = await openDialog();
    const save = within(dlg).getByRole('button', { name: 'Add option' });
    expect(save.disabled).toBe(true);
    expect(dlg.textContent).toMatch(/Enter the term/);
  });
});

describe('The period the option would cover is derived while you type it', () => {
  it('chains from the committed term end', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByPlaceholderText("60"), { target: { value: '60' } });
    await waitFor(() => expect(dlg.querySelector('.opt-covers-note').textContent)
      .toMatch(/January 1, 2028 → December 31, 2032/));
    expect(dlg.querySelector('.opt-covers-note').textContent).toMatch(/5 years/);
  });
});

describe('The notice deadline is entered the way the lease states it', () => {
  it('derives the date from the duration and stores both', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByPlaceholderText("Option 1"), { target: { value: 'Option 1' } });
    fireEvent.change(within(dlg).getByPlaceholderText("60"), { target: { value: '60' } });
    fireEvent.change(within(dlg).getByLabelText('How far ahead notice is due'), { target: { value: '6' } });

    // Counted back from the day the committed term runs out, not from the option start.
    await waitFor(() => expect(dlg.querySelector('.notice-by-read').textContent)
      .toMatch(/June 30, 2027 — counted back from December 31, 2027/));

    fireEvent.change(dlg.querySelector('.opt-rent-block input'), { target: { value: '66000' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add option' }));

    await waitFor(async () => expect(await listRenewals('lease-1')).toHaveLength(1));
    const [opt] = await listRenewals('lease-1');
    expect(opt.notice_by_date).toBe('2027-06-30');
    expect(opt.notice_lead_n).toBe(6);
    expect(opt.notice_lead_unit).toBe('months');
  });

  it('asks for the term first rather than dating from a boundary it is guessing at', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByLabelText('How far ahead notice is due'), { target: { value: '6' } });
    await waitFor(() => expect(dlg.querySelector('.notice-by-read').textContent).toMatch(/Give the option a term above/));
  });
});

describe('Rent escalations as part of the option', () => {
  it('offers a row per option year, dated, and fills them forward from year 1', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByPlaceholderText("60"), { target: { value: '60' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Year by year' }));

    const years = () => [...dlg.querySelectorAll('.opt-year')];
    await waitFor(() => expect(years()).toHaveLength(5));
    // Each year is entered against the date it actually takes effect.
    expect(years()[0].textContent).toMatch(/Year 1from January 1, 2028/);
    expect(years()[4].textContent).toMatch(/Year 5from January 1, 2032/);

    const input = (i) => years()[i].querySelector('input');
    fireEvent.change(input(0), { target: { value: '66000' } });
    fireEvent.change(dlg.querySelector('.opt-fill input'), { target: { value: '3' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Fill' }));

    await waitFor(() => expect(input(1).value).toBe('67980'));
    expect(input(4).value).toBe("74284");   // 66,000 compounding 3% a year

    // It says plainly that this is remembered, not applied.
    expect(dlg.textContent).toMatch(/hidden/);
  });

  it('saves the whole schedule on the option, with year 1 as its stated rent', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByPlaceholderText("Option 1"), { target: { value: 'Option 1' } });
    fireEvent.change(within(dlg).getByPlaceholderText("60"), { target: { value: '24' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Year by year' }));

    const inputs = () => [...dlg.querySelectorAll('.opt-year input')];
    await waitFor(() => expect(inputs()).toHaveLength(2));
    fireEvent.change(inputs()[0], { target: { value: '66000' } });
    fireEvent.change(inputs()[1], { target: { value: '68000' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add option' }));

    await waitFor(async () => expect(await listRenewals('lease-1')).toHaveLength(1));
    const [opt] = await listRenewals('lease-1');
    expect(opt.term_months).toBe(24);
    expect(Number(opt.new_rent)).toBe(66000);            // year 1 is the option's rent
    expect(opt.rent_schedule).toEqual([
      { months_from_option_start: 0, annual: 66000 },
      { months_from_option_start: 12, annual: 68000 },
    ]);
    expect(opt.annual_escalation_pct).toBeNull();        // never two contradictory answers
    // …and nothing has appeared on the rent schedule for an option nobody has taken.
    expect(await screen.findByText('Option 1')).toBeTruthy();
  });

  it('writes only a percentage when that is the answer chosen', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByPlaceholderText("60"), { target: { value: '60' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Rises yearly' }));
    fireEvent.change(dlg.querySelector('.opt-rent-block input'), { target: { value: '3' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add option' }));

    await waitFor(async () => expect(await listRenewals('lease-1')).toHaveLength(1));
    const [opt] = await listRenewals('lease-1');
    expect(Number(opt.annual_escalation_pct)).toBe(3);
    expect(opt.new_rent).toBeNull();
    expect(opt.rent_schedule).toBeNull();
  });
});

describe('The decision column is one shape on every row', () => {
  it('lays the two answers side by side with the follow-up spanning beneath', async () => {
    renderEditor();
    const dlg = await openDialog();
    fireEvent.change(within(dlg).getByPlaceholderText("Option 1"), { target: { value: 'Option 1' } });
    fireEvent.change(within(dlg).getByPlaceholderText("60"), { target: { value: '60' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Flat' }));
    fireEvent.change(dlg.querySelector('.opt-rent-block input'), { target: { value: '66000' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add option' }));

    const cell = await waitFor(() => {
      const el = document.querySelector('.opt-decide');
      expect(el).toBeTruthy();
      return el;
    });
    const buttons = [...cell.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Renew', 'Not renewing', '✉ Email tenant']);
    // The follow-up spans both columns; the two answers each take one.
    expect(buttons[2].classList.contains('opt-wide')).toBe(true);
    expect(buttons[0].classList.contains('opt-wide')).toBe(false);
    expect(buttons[1].classList.contains('opt-wide')).toBe(false);
  });
});
