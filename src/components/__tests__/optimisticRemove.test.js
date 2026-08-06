// "Deleting things needs to happen faster" (George, 2026-08-06) — the row leaves on the
// click, not when the property's invoices have finished rebuilding behind it.
//
// Tested against a mutation that is HELD OPEN on purpose. Against the demo mock every
// call settles in a microtask, so a test there would pass whether the paint was
// optimistic or not — it would be asserting the mock's speed, not the behaviour.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useOptimisticRemove } from '../useOptimisticRemove';

const KEY = ['rows'];

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function List({ seed, run }) {
  // `seed` is a live array, standing in for the server: a mutationFn that really
  // deletes splices it, so a refetch after a failure reports what actually happened
  // rather than resurrecting everything.
  const { data: rows = [] } = useQuery({ queryKey: KEY, queryFn: async () => [...seed] });
  const remove = useOptimisticRemove({ queryKey: KEY, mutationFn: run });
  return (
    <div>
      {rows.map((r) => (
        <div key={r.id}>
          <span>{r.label}</span>
          <button onClick={() => remove.mutate(r)}>remove {r.label}</button>
        </div>
      ))}
      {remove.isError && <div>failed: {String(remove.error?.message)}</div>}
    </div>
  );
}

const mount = (seed, run) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <List seed={seed} run={run} />
    </QueryClientProvider>
  );
};

const seedRows = () => [
  { id: 'a', label: 'Snow removal' },
  { id: 'b', label: 'Landscaping' },
  { id: 'c', label: 'Garbage' },
];
const SEED = seedRows();

beforeEach(() => cleanup());

describe('removing a row optimistically', () => {
  it('takes the row off the list while the server is still working', async () => {
    const held = deferred();
    mount(SEED, () => held.promise);
    await waitFor(() => expect(screen.getByText('Landscaping')).toBeTruthy());

    fireEvent.click(screen.getByText('remove Landscaping'));

    // Nothing has come back from the server — the delete, the re-sum and the
    // property-wide invoice rebuild are all still in flight — and the row is gone.
    await waitFor(() => expect(screen.queryByText('Landscaping')).toBeNull());
    expect(screen.getByText('Snow removal')).toBeTruthy();
    expect(screen.getByText('Garbage')).toBeTruthy();

    held.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByText('Landscaping')).toBeNull());
  });

  it('puts the row BACK if the delete fails, and says why', async () => {
    // ⚠ The half that makes the optimism honest. A row that silently stays gone after a
    // failed delete tells the landlord a cost was removed from the year when it wasn't.
    const held = deferred();
    mount(SEED, () => held.promise);
    await waitFor(() => expect(screen.getByText('Garbage')).toBeTruthy());

    fireEvent.click(screen.getByText('remove Garbage'));
    await waitFor(() => expect(screen.queryByText('Garbage')).toBeNull());

    held.reject(new Error('row is still referenced'));
    await waitFor(() => expect(screen.getByText('Garbage')).toBeTruthy());
    expect(screen.getByText(/failed: row is still referenced/)).toBeTruthy();
    // …and the rest of the list is intact, not just the one row re-appended.
    expect(screen.getByText('Snow removal')).toBeTruthy();
    expect(screen.getByText('Landscaping')).toBeTruthy();
  });

  it('handles several rows going at once without either coming back', async () => {
    const held = deferred();
    mount(SEED, () => held.promise);
    await waitFor(() => expect(screen.getByText('Snow removal')).toBeTruthy());

    fireEvent.click(screen.getByText('remove Snow removal'));
    await waitFor(() => expect(screen.queryByText('Snow removal')).toBeNull());
    fireEvent.click(screen.getByText('remove Garbage'));
    await waitFor(() => expect(screen.queryByText('Garbage')).toBeNull());

    expect(screen.getByText('Landscaping')).toBeTruthy();
    held.resolve({ ok: true });
    await waitFor(() => expect(screen.queryByText('Snow removal')).toBeNull());
    expect(screen.queryByText('Garbage')).toBeNull();
  });

  it('a failure restores its OWN row and not the one deleted after it', async () => {
    // ⚠ The reason the rollback re-inserts a row rather than restoring the pre-click
    // list. Delete two lines quickly and the first mutation's snapshot still contains
    // the second — a snapshot rollback would put a removed cost back into the year and
    // nothing on screen would say it had.
    const first = deferred();
    const second = deferred();
    const server = seedRows();
    const calls = [];
    mount(server, (row) => {
      calls.push(row.id);
      if (calls.length === 1) return first.promise;
      // The second delete really lands, so a refetch must not report it back.
      return second.promise.then((v) => {
        server.splice(server.findIndex((r) => r.id === row.id), 1);
        return v;
      });
    });
    await waitFor(() => expect(screen.getByText('Snow removal')).toBeTruthy());

    fireEvent.click(screen.getByText('remove Snow removal'));
    await waitFor(() => expect(screen.queryByText('Snow removal')).toBeNull());
    fireEvent.click(screen.getByText('remove Garbage'));
    await waitFor(() => expect(screen.queryByText('Garbage')).toBeNull());

    second.resolve({ ok: true });
    first.reject(new Error('could not remove'));

    await waitFor(() => expect(screen.getByText('Snow removal')).toBeTruthy());
    // Garbage really was deleted; the failed sibling must not bring it back.
    expect(screen.queryByText('Garbage')).toBeNull();
  });
});
