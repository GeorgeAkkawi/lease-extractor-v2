import { fmtDate } from './format';

// Riders — the small shared rules about the period a rider governs.
//
// A rider carries TWO different dates and they are routinely months apart:
//   • amendment_date — the day it was signed ("entered into as of June 30, 2023")
//   • effective_from / effective_to — the period it actually governs (0070)
// George, 2026-07-30: "input the dates of the rider". The list, the review form and
// the "Open rider" rows on the lease page all have to describe that period the same
// way, so the wording lives here rather than in three components.

// "Jul 1, 2023 → Apr 30, 2033" · "From Jul 1, 2023" · "Through Apr 30, 2033" ·
// falling back to the signing date, and finally to an em dash. Never invents a date.
export function coversLabel(rider) {
  const from = rider?.effective_from || null;
  const to = rider?.effective_to || null;
  if (from && to) return `${fmtDate(from)} → ${fmtDate(to)}`;
  if (from) return `From ${fmtDate(from)}`;
  if (to) return `Through ${fmtDate(to)}`;
  // No stated period: the day it was signed is the only thing known to be true.
  if (rider?.amendment_date) return `Dated ${fmtDate(rider.amendment_date)}`;
  return '—';
}

// The one-line name for a rider in a list. A rider often has no label of its own
// (the extractor leaves it blank when the document never titles itself), so fall
// back to what it did rather than showing a bare dash.
const KIND_FALLBACK = {
  extension: 'Extension',
  rent_change: 'Rent change',
  new_option: 'Renewal option',
  assignment: 'Assignment',
  other: 'Rider',
};

export function riderTitle(rider) {
  return rider?.label?.trim() || KIND_FALLBACK[rider?.kind] || 'Rider';
}

// Riders in the order they took effect — oldest first, so reading down the list
// walks the lease forward through time. Sorts on the governing date when there is
// one and the signing date otherwise; undated riders sink to the bottom rather
// than jumping to the top (which is what an empty string would do).
export function sortRiders(riders) {
  const key = (r) => r?.effective_from || r?.amendment_date || '';
  return [...(riders || [])].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (!ka && !kb) return 0;
    if (!ka) return 1;
    if (!kb) return -1;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// Does this rider have anything to open? A pasted rider has cached text but no
// file; an uploaded one usually has both. Either is worth a button.
export const riderHasText = (r) => !!(r?.addendum_text && r.addendum_text.trim());
