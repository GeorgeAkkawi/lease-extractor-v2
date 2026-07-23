// Render test for the Settings › Notifications save cue (against the demo mock): after a
// successful save there's nothing left to save, so the button correctly greys — this test
// pins the "Saved ✓" affordance that keeps that from reading as broken (George: "it just
// went grey and i cant click it again"), and that the next edit re-enables "Save changes".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChromeProvider } from '../../context/ChromeContext';

vi.mock('../../context/AuthContext', () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => ({ user: { id: 'demo', email: 'demo@amlak.com' } }),
}));

import NotificationSettings from '../NotificationSettings';

function renderNotify() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <NotificationSettings />
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const input0 = () => document.querySelectorAll('.notify-row .text-input')[0];

beforeEach(() => cleanup());

describe('NotificationSettings — save cue', () => {
  it('reads "Saved ✓" after saving and re-enables "Save changes" on the next edit', async () => {
    renderNotify();
    await waitFor(() => expect(input0()).toBeTruthy());
    // Nothing changed yet → the button is disabled "Save changes".
    const btn = () => screen.getByRole('button', { name: /Save changes|Saved ✓/ });
    expect(btn().disabled).toBe(true);

    // Type a value that differs from the saved default → dirty → button enables.
    fireEvent.change(input0(), { target: { value: '400 days' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ }).disabled).toBe(false));

    // Save → the button greys with a clear "Saved ✓".
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Saved ✓/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: /Saved ✓/ }).disabled).toBe(true);

    // The next edit returns to an enabled "Save changes".
    fireEvent.change(input0(), { target: { value: '450 days' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save changes/ }).disabled).toBe(false));
  });
});
