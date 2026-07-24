// Feature 1 — change password. In the test env DEMO mode is forced, so the mock auth
// object's resetPasswordForEmail/updateUser stubs stand in for Supabase.
//  • ResetPasswordPage enforces the password policy + confirm match, then reaches the
//    "changed / signed out" done state.
//  • SecuritySettings shows the Password card.
//  • Login shows "Forgot your password?" on the sign-in screen.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../../context/AuthContext';
import { ChromeProvider } from '../../context/ChromeContext';
import ResetPasswordPage from '../ResetPasswordPage';
import SecuritySettings from '../SecuritySettings';
import Login from '../Login';

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <ChromeProvider>{ui}</ChromeProvider>
        </AuthProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => cleanup());

describe('ResetPasswordPage', () => {
  it('rejects a weak password and a mismatch, then reaches the done state', async () => {
    wrap(<ResetPasswordPage />);
    const [pw, confirm] = screen.getAllByLabelText(/password/i);

    // Too short.
    fireEvent.change(pw, { target: { value: 'short' } });
    fireEvent.change(confirm, { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    await waitFor(() => expect(screen.getByText('Use at least 10 characters.')).toBeTruthy());

    // Valid but mismatched.
    fireEvent.change(pw, { target: { value: 'Abcdefgh12' } });
    fireEvent.change(confirm, { target: { value: 'Different99' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    await waitFor(() => expect(screen.getByText(/don’t match/i)).toBeTruthy());

    // Valid + matching → updateUser (mock) succeeds → done state.
    fireEvent.change(confirm, { target: { value: 'Abcdefgh12' } });
    fireEvent.click(screen.getByRole('button', { name: /change password/i }));
    await waitFor(() => expect(screen.getByText(/your password has been changed/i)).toBeTruthy());
    expect(screen.getByRole('button', { name: /continue to sign in/i })).toBeTruthy();
  });
});

describe('SecuritySettings', () => {
  it('shows the Password card', async () => {
    wrap(<SecuritySettings />);
    await waitFor(() => expect(screen.getByText('Security · Password')).toBeTruthy());
  });
});

describe('Login', () => {
  it('offers "Forgot your password?" on the sign-in screen', () => {
    render(<Login />);
    expect(screen.getByRole('button', { name: /forgot your password/i })).toBeTruthy();
  });
});
