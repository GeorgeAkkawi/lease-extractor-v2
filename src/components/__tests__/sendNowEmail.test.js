// Render test for the "Send now" flow: mounts the REAL EmailComposeModal against
// the demo mock (DEMO mode forced by the test env, so send-tenant-email resolves to
// { id: 'demo-email' }). Clicking Send now delivers directly (no Gmail) → ✓ Sent
// appears and the caller's onSend logging fires with { to, subject }. With an empty
// recipient the button is disabled so an unaddressed letter can't go out.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmailComposeModal from '../EmailComposeModal';

function renderModal(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EmailComposeModal onClose={() => {}} {...props} />
    </QueryClientProvider>
  );
}

beforeEach(() => cleanup());

describe('EmailComposeModal — Send now', () => {
  it('sends directly and fires the caller onSend logging', async () => {
    const onSend = vi.fn();
    renderModal({ to: 'tenant@example.com', subject: 'Renewal notice', body: 'Your renewal is coming up.', onSend });

    const btn = await screen.findByText('📨 Send now');
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    // Direct send resolves → the button becomes a confirmation and onSend logs it.
    await waitFor(() => expect(screen.getByText('✓ Sent to tenant@example.com')).toBeTruthy());
    expect(onSend).toHaveBeenCalledWith({ to: 'tenant@example.com', subject: 'Renewal notice' });
  });

  it('disables Send now until a recipient is filled in', async () => {
    renderModal({ to: '', subject: 'Renewal notice', body: 'Your renewal is coming up.' });
    const btn = await screen.findByText('📨 Send now');
    expect(btn.disabled).toBe(true);
  });
});
