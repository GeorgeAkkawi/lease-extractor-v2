// Render smoke test for the lease-page red-flag panel. Mounts the REAL LeaseReviewStrip
// against the demo mock, so the whole chain — the free record checks, the click-gated AI
// read, and the save that makes it stick — is exercised.
//
// The point of the panel is that a landlord shouldn't have to know or care which half a
// finding came from, so the central assertion is that both render as one list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseReviewStrip from '../LeaseReviewStrip';
import { ConfirmProvider } from '../ConfirmDialog';
import { getLease, updateLease } from '../../lib/api';

const TODAY = new Date().toISOString().slice(0, 10);

// The review is a PAID read and now asks first, so the panel only works under a
// ConfirmProvider — without one useConfirm's default resolves false and nothing runs.
function renderStrip(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <LeaseReviewStrip escalations={[]} renewals={[]} {...props} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

// Click the panel's review button and approve the dialog it raises.
async function runReview(name = /Review this lease/i) {
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name })));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^(Review|Re-review) lease$/i }));
}

let original;
beforeEach(async () => {
  cleanup();
  original = await getLease('lease-1');
});
afterEach(async () => {
  // The review write is a real update against the mock — put the lease back.
  await updateLease('lease-1', { ai_review: original.ai_review ?? null });
});

describe('LeaseReviewStrip — the free record checks', () => {
  it('names a missing certificate and points at the panel that fixes it', async () => {
    const jumped = [];
    renderStrip({ lease: original, insurance: null, onJump: (p) => jumped.push(p) });
    await waitFor(() => expect(screen.getByText('No certificate of insurance on file')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Go to insurance/i }));
    expect(jumped).toEqual(['insurance']);
  });

  it('says nothing about insurance when the caller never loaded it', async () => {
    // insurance: undefined = the module is off. Reporting "none on file" would be a claim
    // about data we deliberately didn't look at.
    renderStrip({ lease: original });
    await waitFor(() => expect(screen.getByText('Lease review')).toBeTruthy());
    expect(screen.queryByText('No certificate of insurance on file')).toBeNull();
  });

  it('flags a rent step that is past due and unapplied', async () => {
    renderStrip({
      lease: original,
      escalations: [{ id: 'e-past', status: 'scheduled', effective_date: '2020-01-01' }],
      insurance: undefined,
    });
    await waitFor(() => expect(screen.getByText('A rent increase is past due and not applied')).toBeTruthy());
  });
});

describe('LeaseReviewStrip — the AI half', () => {
  it('runs the review on click, saves it, and shows the flags with their quotes', async () => {
    const lease = { ...original, lease_text: 'A short commercial lease with no guaranty and no deposit.' };
    renderStrip({ lease, insurance: undefined });

    await runReview();

    // The demo mock reads the seeded lease text for the same signals the live checklist
    // asks about — this text mentions neither a guaranty nor a deposit.
    await waitFor(() => expect(screen.getByText('No personal guarantee')).toBeTruthy());
    expect(screen.getByText('No security deposit')).toBeTruthy();
    // The clause each one relied on is available but folded away — evidence, not noise.
    expect(screen.getAllByText('What the lease says').length).toBeGreaterThan(1);

    // Saved, so re-opening the lease page costs nothing.
    await waitFor(async () => {
      const saved = await getLease('lease-1');
      expect(saved.ai_review?.flags?.length).toBeGreaterThan(0);
      expect(saved.ai_review.source).toBe('review_button');
    });
  });

  it('disables the review when there is no lease text, and says why', async () => {
    renderStrip({ lease: { ...original, lease_text: null }, insurance: undefined });
    const btn = await waitFor(() => screen.getByRole('button', { name: /Review this lease/i }));
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/no lease document on file/i)).toBeTruthy();
  });

  it('shows a saved review without re-running it, and offers a re-review', async () => {
    const lease = {
      ...original,
      lease_text: 'text',
      ai_review: {
        flags: [{ key: 'cam_capped', severity: 'medium', title: 'CAM / operating expenses are capped', note: 'The tenant’s share is limited.', quote: null }],
        model: 'claude-sonnet-4-6', reviewed_at: `${TODAY}T00:00:00.000Z`, source: 'extract_lease',
      },
    };
    renderStrip({ lease, insurance: undefined });
    await waitFor(() => expect(screen.getByText('CAM / operating expenses are capped')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Re-review/i })).toBeTruthy();
  });

  it('warns that a saved review is stale once the lease has changed under it', async () => {
    const lease = {
      ...original,
      lease_text: 'text',
      updated_at: '2030-01-01T00:00:00.000Z',
      ai_review: { flags: [], model: 'x', reviewed_at: '2026-01-01T00:00:00.000Z', source: 'extract_lease' },
    };
    renderStrip({ lease, insurance: undefined });
    await waitFor(() => expect(screen.getByText(/changed since the AI last read it/i)).toBeTruthy());
  });

  it('does NOT call a review stale just because storing it bumped the lease', async () => {
    // Saving a review is a write to the lease row, so updated_at always lands a moment
    // after reviewed_at. Without the grace window every review would declare itself out
    // of date the instant it was saved — which is what the demo actually did.
    const reviewedAt = '2026-07-29T10:00:00.000Z';
    const lease = {
      ...original,
      lease_text: 'text',
      updated_at: '2026-07-29T10:00:00.300Z',   // 300ms later — the save itself
      ai_review: { flags: [], model: 'x', reviewed_at: reviewedAt, source: 'review_button' },
    };
    renderStrip({ lease, insurance: undefined });
    await waitFor(() => expect(screen.getByText('Lease review')).toBeTruthy());
    expect(screen.queryByText(/changed since the AI last read it/i)).toBeNull();
  });

  it('never calls the review it just ran stale', async () => {
    const lease = { ...original, lease_text: 'text', updated_at: '2030-01-01T00:00:00.000Z' };
    renderStrip({ lease, insurance: undefined });
    await runReview();
    await waitFor(() => expect(screen.getByText('No personal guarantee')).toBeTruthy());
    expect(screen.queryByText(/changed since the AI last read it/i)).toBeNull();
  });

  // The button used to fire the instant it was clicked — the only paid action in the app
  // with no confirmation (George, 2026-08-05). Cancel has to mean cancel: no model call,
  // no write, nothing saved on the lease.
  it('asks before spending, and runs nothing when the landlord cancels', async () => {
    const lease = { ...original, ai_review: null, lease_text: 'A lease with no guaranty on file.' };
    renderStrip({ lease, insurance: undefined });

    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Review this lease/i })));
    const dialog = await screen.findByRole('alertdialog');
    // It states what the action does and what it won't touch — and NO price (George:
    // "take out how much it costs, the user doesn't care about that").
    expect(within(dialog).getByText(/Only this tenant’s lease is read/i)).toBeTruthy();
    expect(within(dialog).getByText(/Nothing is written to the lease’s terms/i)).toBeTruthy();
    expect(dialog.textContent).not.toMatch(/¢|\$\s?\d|\d+\s*cents/i);
    // A read is not a delete — the confirm button must not be the red one.
    expect(dialog.querySelector('.danger-solid')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.queryByText('No personal guarantee')).toBeNull();
    const saved = await getLease('lease-1');
    expect(saved.ai_review?.source).not.toBe('review_button');
  });

  it('warns that a re-review replaces the findings already on screen', async () => {
    const lease = {
      ...original,
      lease_text: 'text',
      ai_review: { flags: [], model: 'x', reviewed_at: `${TODAY}T00:00:00.000Z`, source: 'review_button' },
    };
    renderStrip({ lease, insurance: undefined });
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Re-review/i })));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/replaced by the new read/i)).toBeTruthy();
  });
});

describe('LeaseReviewStrip — marking the findings read', () => {
  const reviewed = (extra = {}) => ({
    flags: [
      { key: 'no_personal_guarantee', severity: 'high', title: 'No personal guarantee', note: 'n', quote: null },
      { key: 'no_late_fee', severity: 'medium', title: 'No late fee', note: 'n', quote: null },
    ],
    model: 'x', reviewed_at: `${TODAY}T00:00:00.000Z`, source: 'review_button', ...extra,
  });

  // "Needs to be a way to dismiss the lease review output in the lease page or else they
  // just sit there" (George, 2026-08-05). Folded away, NOT deleted — the landlord must not
  // have to pay for the review again to find out what it said.
  it('folds the findings away and stamps the lease, without losing them', async () => {
    renderStrip({ lease: { ...original, lease_text: 'text', ai_review: reviewed() }, insurance: undefined });

    await waitFor(() => expect(screen.getByText('No personal guarantee')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Mark as read/i }));

    await waitFor(() => expect(screen.queryByText('No personal guarantee')).toBeNull());
    expect(screen.getByText(/2 points from the document marked read/i)).toBeTruthy();

    const saved = await getLease('lease-1');
    expect(saved.ai_review.dismissed_at).toBeTruthy();
    expect(saved.ai_review.flags).toHaveLength(2);   // still there, still free to re-read
  });

  it('gives them straight back', async () => {
    renderStrip({
      lease: { ...original, lease_text: 'text', ai_review: reviewed({ dismissed_at: `${TODAY}T09:00:00.000Z` }) },
      insurance: undefined,
    });

    await waitFor(() => expect(screen.getByText(/marked read/i)).toBeTruthy());
    expect(screen.queryByText('No personal guarantee')).toBeNull();
    // …and it must not claim the AI found nothing while saying it folded something away.
    expect(screen.queryByText(/found no missing protections/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Show them again/i }));
    await waitFor(() => expect(screen.getByText('No personal guarantee')).toBeTruthy());
    const saved = await getLease('lease-1');
    expect(saved.ai_review.dismissed_at).toBeUndefined();
  });

  it('offers nothing to dismiss when there is nothing saved to read', async () => {
    renderStrip({ lease: { ...original, lease_text: 'text', ai_review: null }, insurance: undefined });
    await waitFor(() => expect(screen.getByText('Lease review')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Mark as read/i })).toBeNull();
  });
});

describe('LeaseReviewStrip — both halves together', () => {
  it('merges AI and record findings into ONE list, most severe first', async () => {
    const lease = {
      ...original,
      lease_text: 'text',
      ai_review: {
        flags: [{ key: 'exclusive_use', severity: 'info', title: 'Exclusive-use clause', note: 'Limits who else you can lease to.', quote: null }],
        model: 'x', reviewed_at: `${TODAY}T00:00:00.000Z`, source: 'extract_lease',
      },
    };
    const { container } = renderStrip({ lease, insurance: null });   // → a high-severity COI finding
    await waitFor(() => expect(screen.getByText('Exclusive-use clause')).toBeTruthy());
    expect(screen.getByText('No certificate of insurance on file')).toBeTruthy();

    const items = [...container.querySelectorAll('.review-item')];
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0].className).toContain('high');   // the record finding outranks the info flag
    expect(screen.getByText(/points to look at/i)).toBeTruthy();
  });

  it('says so plainly when there is nothing to flag', async () => {
    const clean = {
      ...original,
      base_rent: 84000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31',
      is_active: true, roof_responsible: false, lease_text: 'text',
      ai_review: { flags: [], model: 'x', reviewed_at: `${TODAY}T00:00:00.000Z`, source: 'review_button' },
    };
    renderStrip({
      lease: clean,
      insurance: { id: 'i1', insurer: 'Summit', expiry_date: '2030-01-01', additional_insured: true },
    });
    await waitFor(() => expect(screen.getByText(/Nothing flagged/i)).toBeTruthy());
  });

  it('always carries the not-legal-advice line', async () => {
    renderStrip({ lease: original, insurance: undefined });
    await waitFor(() => expect(screen.getByText(/reading aid, not legal advice/i)).toBeTruthy());
  });
});
