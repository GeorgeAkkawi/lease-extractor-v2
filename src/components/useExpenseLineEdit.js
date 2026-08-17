import { useMutation } from '@tanstack/react-query';
import { updateExpenseLineItem } from '../lib/api';

// The one mutation behind "click the name or the date on an expense row and change it"
// (George, 2026-08-17). CAM, property taxes and roof are three lists over ONE table, and
// they already carry three copies of add / remove / save-flat / undo. A fourth triplet
// would be a fourth chance for the three to disagree about what an edit does — so the
// write lives here once and each section supplies only its own sentence.
//
// Undo is free and lossless: the previous value is on the row we were handed, and neither
// field moves money (see updateExpenseLineItem for the walk), so putting it back is a
// plain second write with nothing to unwind behind it.
//
// @param invalidate  the section's existing refresh — the list key, which RecoverabilityTable
//                    reads too, so the "What it cost you" table repaints with the row.
// @param setSaved    the section's one { label, undo } slot, shown by UndoStrip.
// @param describe    ({ item, field, value }) => the sentence for that strip. CAM's names
//                    the tax line a rename re-files under; the other two have no buckets.
export function useExpenseLineEdit({ invalidate, setSaved, describe }) {
  return useMutation({
    mutationFn: ({ item, field, value }) => updateExpenseLineItem(item.id, { [field]: value }),
    onSuccess: (_row, vars) => {
      invalidate();
      setSaved({
        label: describe(vars),
        undo: () => updateExpenseLineItem(vars.item.id, { [vars.field]: vars.item[vars.field] ?? null }),
      });
    },
  });
}
