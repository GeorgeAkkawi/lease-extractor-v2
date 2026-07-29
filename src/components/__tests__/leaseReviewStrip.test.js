// Render smoke test for the lease-page red-flag panel. Mounts the REAL LeaseReviewStrip
// against the demo mock, so the whole chain — the free record checks, the click-gated AI
// read, and the save that makes it stick — is exercised.
//
// The point of the panel is that a landlord shouldn't have to know or care which half a
// finding came from, so the central assertion is that both render as one list.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeaseReviewStrip from '../LeaseReviewStrip';
import { getLease, updateLease } from '../../lib/api';

const TODAY = new Date().toISOString().slice(0, 10);

function renderStrip(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LeaseReviewStrip escalations={[]} renewals={[]} {...props} />
    </QueryClientProvider>
  );
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

    const btn = await waitFor(() => screen.getByRole('button', { name: /Review this lease/i }));
    fireEvent.click(btn);

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
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Review this lease/i })));
    await waitFor(() => expect(screen.getByText('No personal guarantee')).toBeTruthy());
    expect(screen.queryByText(/changed since the AI last read it/i)).toBeNull();
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
