// Mounts the REAL PropertyAnnouncementsModal against the demo mock (DEMO mode is forced
// by the test env, so draft-announcement / send-announcement resolve to the mock's canned
// shapes). Covers the four things George actually asked for:
//   ① one click reaches every tenant, with anyone excludable
//   ② an accidental close doesn't cost the typing
//   ③ a saved template reopens carrying today's date
//   ④ the notice never carries a tenant-specific detail
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PropertyAnnouncementsModal from '../PropertyAnnouncementsModal';
import { ConfirmProvider } from '../ConfirmDialog';
import { letterDate } from '../../lib/emailTemplates';
import { supabase } from '../../lib/supabaseClient';

const property = { id: 'prop-1', name: 'Maple Plaza', address: '100 Maple St' };
const corp = {
  id: 'corp-1',
  name: 'Acme Holdings',
  address: '100 Maple St, Suite 500, Springfield, IL 62701',
  contact_email: 'leasing@acmeholdings.example',
};

function renderModal(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <PropertyAnnouncementsModal property={property} corp={corp} onClose={() => {}} {...props} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

// This suite's jsdom has NO localStorage (node's experimental one needs --localstorage-file,
// so `typeof localStorage === 'undefined'` here). The app copes — every read/write is inside
// a try/catch — but the draft-survives-a-close behaviour is exactly what needs covering, so
// stand up a minimal in-memory one. Scoped to this file; vitest isolates per test file.
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

beforeEach(() => {
  cleanup();
  localStorage.clear();
});
afterEach(() => localStorage.clear());

async function draftOne(ask = 'the parking lot is being resurfaced the week of the 14th') {
  const request = await screen.findByPlaceholderText(/parking lot is being resurfaced/i);
  fireEvent.change(request, { target: { value: ask } });
  fireEvent.click(screen.getByText('✨ Draft with AI'));
  // The letter lands in the body textarea. (Don't match on the subject text — "Parking Lot
  // Work" appears in the RE: line too, so a value query would find two fields.)
  await waitFor(() =>
    expect(document.querySelector('textarea.announce-body').value).toContain('Dear Tenants,')
  );
}

describe('PropertyAnnouncementsModal — recipients', () => {
  it('lists every tenant on the property, all selected by default', async () => {
    renderModal();
    expect(await screen.findByText('Bright Coffee Co.')).toBeTruthy();
    expect(screen.getByText('City Dental')).toBeTruthy();
    // Maple Plaza has two tenants, both with an email on file.
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.getByText(/Send to 2 tenants/)).toBeTruthy();
  });

  it('unticking a tenant drops them from the count and the send button', async () => {
    renderModal();
    await screen.findByText('Bright Coffee Co.');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.every((b) => b.checked)).toBe(true);

    fireEvent.click(boxes[0]);
    await waitFor(() => expect(screen.getByText('1 of 2')).toBeTruthy());
    expect(screen.getByText(/Send to 1 tenant$/)).toBeTruthy();
  });

  it('“None” then “Select all” restores everyone', async () => {
    renderModal();
    await screen.findByText('Bright Coffee Co.');
    fireEvent.click(screen.getByText('None'));
    await waitFor(() => expect(screen.getByText('0 of 2')).toBeTruthy());
    fireEvent.click(screen.getByText('Select all'));
    await waitFor(() => expect(screen.getByText('2 of 2')).toBeTruthy());
  });
});

describe('PropertyAnnouncementsModal — drafting', () => {
  it('drafts a notice that names no individual tenant', async () => {
    renderModal();
    await draftOne();

    const textarea = document.querySelector('textarea.announce-body');
    expect(textarea.value).toContain('Dear Tenants,');
    expect(textarea.value).toContain('Maple Plaza');
    expect(textarea.value).toContain('Acme Holdings');
    // The one rule that makes a one-click send to everybody safe.
    expect(textarea.value).not.toContain('Bright Coffee Co.');
    expect(textarea.value).not.toContain('City Dental');
    expect(textarea.value).not.toContain('sam@brightcoffee.example');
  });

  it('offers ↻ Rewrite with AI only once something has been drafted', async () => {
    renderModal();
    await screen.findByText('✨ Draft with AI');
    expect(screen.queryByText('↻ Rewrite with AI')).toBe(null);
    await draftOne();
    expect(screen.getByText('↻ Rewrite with AI')).toBeTruthy();
  });
});

describe('PropertyAnnouncementsModal — a closed window keeps the work', () => {
  it('restores the draft after the modal is closed and reopened', async () => {
    const { unmount } = renderModal();
    await draftOne();
    const typed = document.querySelector('textarea.announce-body').value;
    // Exclude someone too — the exclusion must come back as well.
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await waitFor(() => expect(screen.getByText('1 of 2')).toBeTruthy());

    unmount();
    cleanup();

    renderModal();
    expect(await screen.findByText(/Draft restored from last time/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector('textarea.announce-body').value).toBe(typed));
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });

  it('“Start over” clears the stored draft for good', async () => {
    const { unmount } = renderModal();
    await draftOne();
    unmount();
    cleanup();

    renderModal();
    fireEvent.click(await screen.findByText('Start over'));
    await waitFor(() => expect(document.querySelector('textarea.announce-body').value).toBe(''));

    unmount();
    cleanup();
    renderModal();
    await screen.findByText('✨ Draft with AI');
    expect(screen.queryByText(/Draft restored/)).toBe(null);
  });
});

describe('PropertyAnnouncementsModal — templates', () => {
  it('the seeded template loads carrying today’s date and this property', async () => {
    renderModal();
    fireEvent.click(await screen.findByText('Winter weather procedures'));

    await waitFor(() => {
      const body = document.querySelector('textarea.announce-body').value;
      expect(body).toContain(letterDate());       // stamped today, not the year it was saved
      expect(body).toContain('Maple Plaza');      // {property} resolved
      expect(body).toContain('Acme Holdings');    // {business} resolved
      expect(body).not.toContain('{');            // no token left visible in a real letter
    });
    expect(screen.getByDisplayValue('Winter Weather Procedures — Maple Plaza')).toBeTruthy();
  });

  it('saves the current notice as a new template', async () => {
    renderModal();
    await draftOne();

    fireEvent.click(screen.getByText('⭑ Save as template'));
    fireEvent.change(await screen.findByPlaceholderText('Name this announcement'), {
      target: { value: 'Lot resurfacing' },
    });
    fireEvent.click(screen.getByText('Save template'));

    await waitFor(() => expect(screen.getByText('Lot resurfacing')).toBeTruthy());
  });
});

// George, 2026-08-04: *"its because mario is the same email for 2 tenants — so we should
// only send one email if the same tenant owns two businesses in the same building but still
// George, 2026-08-04: *"dennys doesnt have an email on file and its hard to see that on the
// announcements, make the formatting the same as the other tenants but just make the box
// uncheckable until an email is added."* The row used to have NO checkbox at all, so it was a
// different shape from its neighbours and the eye slid past it — which is how a tenant
// silently drops out of an announcement nobody realises they missed.
describe('PropertyAnnouncementsModal — a tenant with no email on file', () => {
  const ORIGINAL = 'billing@citydental.example';
  beforeEach(async () => {
    await supabase.from('leases').update({ tenant_email: null }).eq('id', 'lease-2');
  });
  afterEach(async () => {
    await supabase.from('leases').update({ tenant_email: ORIGINAL }).eq('id', 'lease-2');
  });

  it('is the same row as everyone else, with a checkbox that cannot be ticked', async () => {
    renderModal();
    const row = (await screen.findByText('City Dental')).closest('.announce-recipient');
    const box = row.querySelector('input[type="checkbox"]');

    // The shape is the point: a checkbox exists, it is visibly off, and it is unusable.
    expect(box).toBeTruthy();
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    // …and the reason is on the row, not left to be inferred from a missing address.
    expect(row.textContent).toContain('no email on file — add one to include them');
  });

  it('still leaves them out of the send, and out of the count', async () => {
    renderModal();
    await screen.findByText('City Dental');
    // Bright Coffee alone is mailable — the visible row must not become a silent recipient.
    expect(screen.getByText('1 of 1')).toBeTruthy();
    expect(screen.getByText(/Send to 1 tenant/)).toBeTruthy();
  });

  it('becomes a normal, tickable row the moment an address is added', async () => {
    await supabase.from('leases').update({ tenant_email: ORIGINAL }).eq('id', 'lease-2');
    renderModal();
    const row = (await screen.findByText('City Dental')).closest('.announce-recipient');
    expect(row.querySelector('input[type="checkbox"]').disabled).toBe(false);
    expect(row.textContent).not.toContain('no email on file');
  });
});

// mark 4/4"*. One landlord, two businesses, one inbox: BOTH tenancies count as notified, and
// he gets ONE copy. The first cut counted unique addresses and read "3 of 4", which looked
// like two of his selections had been silently dropped.
describe('PropertyAnnouncementsModal — two tenancies sharing one contact address', () => {
  const SHARED = 'sam@brightcoffee.example';   // already Bright Coffee's address
  const ORIGINAL = 'billing@citydental.example';

  // Point City Dental at Bright Coffee's inbox, then put it back — the demo store is
  // module-level and shared with the suites above/below.
  beforeEach(async () => {
    await supabase.from('leases').update({ tenant_email: SHARED }).eq('id', 'lease-2');
  });
  afterEach(async () => {
    await supabase.from('leases').update({ tenant_email: ORIGINAL }).eq('id', 'lease-2');
  });

  it('counts TENANTS, not addresses — both still read as selected', async () => {
    renderModal();
    expect(await screen.findByText('Bright Coffee Co.')).toBeTruthy();
    // Two tenants, one address: the count must stay 2 of 2, not collapse to 1 of 2.
    expect(screen.getByText('2 of 2')).toBeTruthy();
    expect(screen.getByText(/Send to 2 tenants/)).toBeTruthy();
  });

  it('explains the difference instead of leaving a number that looks wrong', async () => {
    renderModal();
    await screen.findByText('Bright Coffee Co.');
    expect(screen.getByText(/1 email for 2 tenants — 2 of them share an address/)).toBeTruthy();
    // …and the rows say which ones, so he doesn't have to compare addresses by eye.
    expect(screen.getAllByText(new RegExp(`${SHARED} · shared address`))).toHaveLength(2);
  });

  it('sends ONE email but reports both tenants as reached', async () => {
    renderModal();
    await draftOne();
    fireEvent.click(screen.getByText(/Send to 2 tenants/));
    await screen.findByText('Send this announcement?');
    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 tenants' }));

    // 2 tenants notified, 1 message actually delivered — both stated, neither implied.
    await waitFor(() => expect(screen.getByText('✓ Sent to 2 tenants · 1 email')).toBeTruthy());
  });

  it('drops back to a plain count once the shared address is gone', async () => {
    await supabase.from('leases').update({ tenant_email: ORIGINAL }).eq('id', 'lease-2');
    renderModal();
    await screen.findByText('Bright Coffee Co.');
    expect(screen.queryByText(/share an address/)).toBe(null);
    expect(screen.queryByText(/· shared address/)).toBe(null);
  });
});

describe('PropertyAnnouncementsModal — sending', () => {
  it('will not send until there is a subject, a body and a recipient', async () => {
    renderModal();
    await screen.findByText('Bright Coffee Co.');
    expect(screen.getByText(/Send to 2 tenants/).disabled).toBe(true);   // nothing written yet

    await draftOne();
    expect(screen.getByText(/Send to 2 tenants/).disabled).toBe(false);

    fireEvent.click(screen.getByText('None'));
    await waitFor(() => expect(screen.getByText(/Send to 0 tenants/).disabled).toBe(true));
  });

  it('confirms first, then reports how many actually went out', async () => {
    renderModal();
    await draftOne();

    fireEvent.click(screen.getByText(/Send to 2 tenants/));

    // The confirm names every recipient before anything is sent.
    const dialog = await screen.findByText('Send this announcement?');
    expect(dialog).toBeTruthy();
    expect(screen.getByText(/Bright Coffee Co\. — sam@brightcoffee\.example/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send to 2 tenants' }));
    await waitFor(() => expect(screen.getByText('✓ Sent to 2 tenants')).toBeTruthy());
  });

  it('cancelling the confirm sends nothing', async () => {
    renderModal();
    await draftOne();
    fireEvent.click(screen.getByText(/Send to 2 tenants/));
    fireEvent.click(await screen.findByText('Not yet'));

    await waitFor(() => expect(screen.queryByText('Send this announcement?')).toBe(null));
    expect(screen.queryByText(/✓ Sent to/)).toBe(null);
  });
});
