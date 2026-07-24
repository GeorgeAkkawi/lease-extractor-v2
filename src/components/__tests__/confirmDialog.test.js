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
