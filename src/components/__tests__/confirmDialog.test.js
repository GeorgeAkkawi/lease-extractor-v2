// The shared professional confirm dialog (replaces window.confirm on destructive
// actions): the message + a highlighted "implications" list, resolving true on confirm
// and false on cancel / Escape / scrim — so a delete only fires when the user approves.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { ConfirmProvider, useConfirm } from '../ConfirmDialog';

// The button must consume the SAME provider it renders under, so it sits inside one.
function Inner({ onResult, options }) {
  const askConfirm = useConfirm();
  return <button onClick={async () => onResult(await askConfirm(options))}>go</button>;
}

beforeEach(() => cleanup());

describe('ConfirmDialog', () => {
  it('shows the title, message, and highlighted implications, and resolves true on confirm', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Inner
          onResult={onResult}
          options={{
            title: 'Delete this thing?',
            message: 'Are you sure?',
            implications: ['It is gone forever.', 'No undo.'],
            confirmLabel: 'Delete',
          }}
        />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByText('go'));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Delete this thing?')).toBeTruthy();
    expect(within(dialog).getByText('It is gone forever.')).toBeTruthy();
    expect(within(dialog).getByText('No undo.')).toBeTruthy();
    // The implications sit in the highlighted box.
    expect(dialog.querySelector('.confirm-imp')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    // Dialog closes after resolving.
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false on Cancel', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Inner onResult={onResult} options={{ title: 'X?', confirmLabel: 'Delete' }} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByText('go'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  it('resolves false on Escape', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Inner onResult={onResult} options={{ title: 'X?' }} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByText('go'));
    await screen.findByRole('alertdialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });
});

// ⚠ SOME DECISIONS HAVE THREE WAYS FORWARD, and forcing them into OK/Cancel makes the third
// one invisible. Closing a year over open balances can carry them all forward, freeze them as
// they stand, or send the landlord to settle them one at a time — genuinely different outcomes
// with different consequences, which is why each choice states its own beneath its label.
describe('ConfirmDialog — a fork rather than a yes/no', () => {
  it('renders each choice with its consequence and resolves to the key that was clicked', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Inner
          onResult={onResult}
          options={{
            title: 'Close FY 2026 — 2 open balances',
            message: 'Northwind owes $89,250.00',
            implications: ['The snapshot is the lock.'],
            choices: [
              { key: 'carry', label: 'Carry them all forward, then close', tone: 'primary', hint: 'Each balance moves into January 2027.' },
              { key: 'leave', label: 'Leave them open, and close anyway', hint: 'Frozen as it stands.' },
              { key: 'settle', label: 'Settle them one at a time first', hint: 'Takes you to the Ledger.' },
            ],
            cancelLabel: 'Not now',
          }}
        />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByText('go'));
    const dialog = await screen.findByRole('alertdialog');

    // Every choice, and its hint — the hint is the whole reason this is not three plain buttons.
    expect(within(dialog).getByText('Each balance moves into January 2027.')).toBeTruthy();
    expect(within(dialog).getByText('Frozen as it stands.')).toBeTruthy();
    expect(within(dialog).getByText('Takes you to the Ledger.')).toBeTruthy();
    // …and the ordinary confirm button is NOT there: with a fork there is no single "yes".
    expect(within(dialog).queryByText('Delete')).toBeNull();
    expect(within(dialog).getByText('Not now')).toBeTruthy();

    fireEvent.click(within(dialog).getByText('Leave them open, and close anyway'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith('leave'));
  });

  it('still resolves false on cancel, so a caller that only checks truthiness is safe', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Inner onResult={onResult} options={{ title: 'Pick one', choices: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByText('go'));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Cancel'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
  });

  // ⚠ THE OLD SHAPE IS UNTOUCHED. Every other confirm in the app goes through this component,
  // so `choices` being absent has to behave exactly as it did — one confirm button, resolving
  // `true`. This is the regression that would break twenty call sites at once.
  it('is byte-identical when no choices are given', async () => {
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Inner onResult={onResult} options={{ title: 'Delete this thing?', confirmLabel: 'Delete' }} />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByText('go'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.querySelector('.confirm-choices')).toBeNull();
    fireEvent.click(within(dialog).getByText('Delete'));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  });
});
