// One way to hand a generated file to the browser.
//
// Every export in this app (the tax package, the lender package, the 1099 worksheet, the
// reconciliation report, the rent roll) ends the same way: build a Blob, then get it onto
// the user's disk. Five hand-rolled copies of that tail is exactly the drift §3 warns
// about — so it lives here once.
//
// ⚠ TWO THINGS THE HAND-ROLLED VERSION GOT WRONG, and both are silent failures.
//
//   1. The anchor was never in the document. Chrome dispatches a click on a detached
//      <a download> and honours it; Safari and Firefox are documented to drop it. So an
//      export that "works on my machine" simply does nothing on someone else's, with no
//      error to see.
//
//   2. revokeObjectURL fired SYNCHRONOUSLY, on the line after .click(). The download is
//      still starting at that point, so revoking can cancel the very fetch it just began.
//      It survives on fast machines and races on slow ones — the worst kind of bug,
//      because it looks like the button did nothing.
//
// Both are fixed here: the anchor is appended, clicked, removed; the URL is revoked on a
// later tick, once the browser has taken the blob.
const REVOKE_AFTER_MS = 60_000;

/**
 * Save a Blob as a file, in a way every browser actually honours.
 *
 * @param {Blob} blob     the file's bytes
 * @param {string} filename  what it should be called on disk
 * @returns {string} the object URL that was used (handy in tests)
 */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  // In the document, or Safari/Firefox ignore the click entirely.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Never synchronously — the download may not have taken the blob yet.
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
  return url;
}

/**
 * Save an ExcelJS workbook buffer under a filename built from a label.
 * The slug rule is shared so every export in the app names its file the same way.
 *
 * @param {ArrayBuffer} buf   the result of `workbook.xlsx.writeBuffer()`
 * @param {string} filename   the full filename, including .xlsx
 */
export function saveWorkbook(buf, filename) {
  const blob = new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  return saveBlob(blob, filename);
}

/** Turn a corporation / property name into a filename-safe slug. */
export function fileSlug(name, fallback = 'export') {
  const slug = String(name || '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return slug || fallback;
}
