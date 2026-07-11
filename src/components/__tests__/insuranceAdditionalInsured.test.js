// Render smoke tests for the additional-insured notice: mounts the REAL
// InsuranceVault against the demo mock (DEMO mode forced by the test env).
// Bright Coffee's seeded cert (ins-2) has additional_insured: false → pop-up +
// red banner + red badge; dismissing hides ONLY the pop-up; City Dental's cert
// names the landlord → no notice at all.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InsuranceVault from '../InsuranceVault';

function renderVault(leaseId, onRequestRenewal = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InsuranceVault party="tenant" propertyId="prop-1" leaseId={leaseId} onRequestRenewal={onRequestRenewal} />
    </QueryClientProvider>
  );
}

const POPUP_TITLE = '⚠ Not listed as additional insured';
const BANNER = /You are not listed as additional insured on this certificate/;

beforeEach(() => cleanup());

describe('InsuranceVault — additional-insured notice', () => {
  it('pops up + banners a cert that omits the landlord; the email button carries the reason', async () => {
    const onRequest = vi.fn();
    renderVault('lease-1', onRequest);
    // Pop-up, persistent banner, and the red badge all render off the seeded false cert.
    await waitFor(() => expect(screen.getByText(POPUP_TITLE)).toBeTruthy());
    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.getByText('No — not listed')).toBeTruthy();
    // Pop-up's primary button dismisses AND opens the corrected-certificate email.
    const buttons = screen.getAllByText('✉ Request corrected certificate');
    expect(buttons.length).toBe(2); // one in the pop-up, one on the banner
    fireEvent.click(buttons[buttons.length - 1]); // the pop-up's (rendered last)
    expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ id: 'ins-2' }), 'additional_insured');
    // Dismissal persisted → pop-up unmounts, banner + badge stay.
    await waitFor(() => expect(screen.queryByText(POPUP_TITLE)).toBeNull());
    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.getByText('No — not listed')).toBeTruthy();
  });

  it('stays dismissed on a remount of the SAME certificate (quiet until the cert changes)', async () => {
    renderVault('lease-1');
    await waitFor(() => expect(screen.getByText(BANNER)).toBeTruthy());
    // The prior test stored the dismissal in the mock's alert_states — no pop-up now.
    expect(screen.queryByText(POPUP_TITLE)).toBeNull();
  });

  it('shows nothing for a cert that names the landlord', async () => {
    renderVault('lease-2');
    // City Dental's cert (ins-3) is additional_insured: true → green Yes, no notice.
    await waitFor(() => expect(screen.getByText('Yes')).toBeTruthy());
    expect(screen.queryByText(POPUP_TITLE)).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(screen.queryByText('No — not listed')).toBeNull();
  });
});
