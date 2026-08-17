// Loading a code-split chunk — and the one way that fails which is nobody's fault.
//
// George, 2026-08-17: *"i got a Failed to fetch dynamically imported module:
// https://www.amlakre.com/assets/exceljs.min-DjXlhIcS.js"* on two different exports.
//
// ⚠ WHAT IS ACTUALLY HAPPENING, because it looks like a broken export and is not.
// The spreadsheet writer (~937 kB) and the PDF renderer are deliberately NOT in the main
// bundle — they are fetched the moment you first need them, which is why the app loads fast
// and why `await import()` appears at six places in this codebase. Every `wrangler deploy`
// replaces the Worker's asset manifest, so the previous build's hashed chunks stop existing.
// A tab opened before a deploy carries on working — its main bundle is already in memory —
// until it asks for a lazy chunk that has since been deleted. Which is: until you click
// Export, or open a document to sign.
//
// The Worker then makes it worse in a specific way. `not_found_handling:
// "single-page-application"` answers the missing path with **index.html, 200, text/html**
// (measured: 2,290 bytes of HTML where the live chunk is 936,982 bytes of JavaScript), so
// the browser doesn't even get a 404 — it gets a page where a module should be, and reports
// that in its own words.
//
// None of this is fixable by finding the file: it is genuinely gone. What was fixable is
// that the app repeated the browser's sentence instead of saying what happened, and offered
// nothing to do about it. `isStaleBuildError` is exported so a screen can put a Reload
// button next to the message rather than only printing one.

export class StaleBuildError extends Error {
  constructor(what) {
    super(`Amlak was updated while this page was open, so ${what} could no longer be loaded. Reload the page and try again.`);
    this.name = 'StaleBuildError';
    // The flag, not the class, is what call sites test — an error crossing a bundle boundary
    // can fail `instanceof` while still being exactly this.
    this.stale = true;
  }
}

// One event, four engines, four wordings. The MIME line is the one the SPA fallback actually
// produces, because the request SUCCEEDS and hands back a page.
const STALE_CHUNK = [
  /failed to fetch dynamically imported module/i,   // Chrome, Edge
  /error loading dynamically imported module/i,     // Firefox
  /importing a module script failed/i,              // Safari
  /expected a javascript module script/i,           // the SPA fallback's shape
  /failed to load module script/i,
  /unable to preload/i,                             // Vite's own preload helper
];

export const isStaleBuildError = (e) =>
  !!e && (e.stale === true || STALE_CHUNK.some((re) => re.test(String(e?.message || ''))));

// Load a lazy chunk, and translate ONLY the stale-build failure.
//
// ⚠ Everything else is rethrown byte for byte, and that restraint is the point. A catch-all
// here would relabel a real bug inside the workbook code as "reload the page" — the landlord
// reloads, it happens again, and the actual error is never seen by anyone. Pinned by a test.
//
// @param loader  () => import('…') — kept as a thunk so the bundler still sees a literal
//                specifier at the call site and can split the chunk.
// @param what    what the landlord was trying to use, in their words ("the spreadsheet
//                builder"), because "a dynamically imported module" is not a thing they own.
export async function loadModule(loader, what = 'part of the page') {
  try {
    return await loader();
  } catch (e) {
    if (isStaleBuildError(e)) throw new StaleBuildError(what);
    throw e;
  }
}
