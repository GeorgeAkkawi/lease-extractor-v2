import { useMutation, useQueryClient } from '@tanstack/react-query';

// A row leaves the list the moment you click ✕, not when the server has finished with it
// (George, 2026-08-06: "deleting things needs to happen faster").
//
// WHAT WAS ACTUALLY SLOW. Nothing here makes the database quicker. Removing an expense
// line has always been a delete, the kind's total re-summed, and then every invoice on
// the property rebuilt — seconds of real work, correctly done. The fault was that the
// row sat on screen for all of it with nothing saying why, so the click read as ignored
// and the landlord clicked again. The work still happens; it just happens behind a list
// that already shows the answer.
//
// ⚠ THE ROW COMES BACK IF THE DELETE FAILS, and the caller must show the error
// (`MutationError of={[remove]}`). A row that silently reappears is worse than one that
// never left — it looks like the app undid a decision on its own.
//
// One implementation rather than one per list: six lists delete a row this way, and six
// copies of an optimistic cache write is six chances for one of them to forget the
// rollback.
export function useOptimisticRemove({ queryKey, mutationFn, onSuccess, idOf = (row) => row?.id }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (row) => {
      // An in-flight refetch would land after this and put the row straight back.
      await qc.cancelQueries({ queryKey });
      const list = qc.getQueryData(queryKey);
      if (!Array.isArray(list)) return {};
      const id = idOf(row);
      // Nothing to match on → leave the list alone rather than filter by identity and
      // take out the wrong row.
      if (id == null) return {};
      const index = list.findIndex((r) => idOf(r) === id);
      if (index < 0) return {};
      qc.setQueryData(queryKey, list.filter((r) => idOf(r) !== id));
      return { removed: list[index], index };
    },
    // ⚠ PUT BACK THE ONE ROW, NOT THE WHOLE SNAPSHOT. Restoring the pre-click list is
    // the usual pattern and it is wrong the moment two rows are deleted in quick
    // succession: the first mutation's snapshot still contains the second row, so one
    // failure resurrects a line the landlord had already removed.
    onError: (_err, _row, ctx) => {
      if (ctx?.removed) {
        qc.setQueryData(queryKey, (cur) => {
          const rows = Array.isArray(cur) ? cur : [];
          if (rows.some((r) => idOf(r) === idOf(ctx.removed))) return rows;
          const next = [...rows];
          next.splice(Math.min(ctx.index, next.length), 0, ctx.removed);
          return next;
        });
      }
      // …then let the server settle it. These mutations delete the row FIRST and carry
      // the change through afterwards, so a failure in the carry-through leaves a row
      // that is genuinely gone — the rollback above would otherwise leave a phantom on
      // screen until the landlord navigated away.
      qc.invalidateQueries({ queryKey });
    },
    onSuccess,
  });
}

export default useOptimisticRemove;
