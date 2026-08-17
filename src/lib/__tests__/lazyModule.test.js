// George, 2026-08-17: "i got a Failed to fetch dynamically imported module:
// https://www.amlakre.com/assets/exceljs.min-DjXlhIcS.js when trying to import sams nails on
// the export reconciliation and for income and expenses"
//
// ROOT CAUSE, measured against the live site rather than guessed. The spreadsheet writer is a
// code-split chunk — it is not downloaded until you click Export. Every `wrangler deploy`
// replaces the asset manifest, so the PREVIOUS build's hashed chunks stop existing. A tab
// opened before a deploy keeps working (its main bundle is already in memory) right up until
// it asks for a lazy chunk that has since been deleted.
//
// And the Worker's SPA fallback (`not_found_handling: "single-page-application"`) then answers
// that request with **index.html, 200, text/html** — verified: the URL in George's error
// returns 2,290 bytes of HTML while the current chunk returns 936,982 bytes of JavaScript. So
// the browser refuses an HTML body as a module and reports it in its own words, which is the
// message he saw. Nothing was wrong with Sam Nails, the figures, or the workbook code.
//
// This is not fixable by keeping the file: it is genuinely gone. What IS fixable is that the
// app said it in the browser's words instead of its own, and offered nothing to do about it.
import { describe, it, expect } from 'vitest';
import { loadModule, isStaleBuildError, StaleBuildError } from '../lazyModule';

// The same failure, as each engine words it. All four are the same event.
const CHROME = 'Failed to fetch dynamically imported module: https://www.amlakre.com/assets/exceljs.min-DjXlhIcS.js';
const FIREFOX = 'error loading dynamically imported module';
const SAFARI = 'Importing a module script failed.';
// What the SPA fallback actually produces: the request SUCCEEDS and returns a page.
const MIME = 'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".';

const rejectWith = (msg) => () => Promise.reject(new TypeError(msg));

describe('loadModule — a chunk the last deploy took away', () => {
  for (const [engine, msg] of [['Chrome', CHROME], ['Firefox', FIREFOX], ['Safari', SAFARI], ['a MIME refusal', MIME]]) {
    it(`recognises ${engine}'s wording and says what to do about it`, async () => {
      await expect(loadModule(rejectWith(msg), 'the spreadsheet builder')).rejects.toThrow(StaleBuildError);
      const err = await loadModule(rejectWith(msg), 'the spreadsheet builder').catch((e) => e);
      // It names the thing that couldn't load, and the one action that fixes it.
      expect(err.message).toMatch(/updated while this page was open/i);
      expect(err.message).toMatch(/the spreadsheet builder/);
      expect(err.message).toMatch(/reload/i);
      // The flag is what lets a screen offer a Reload button rather than only print a sentence.
      expect(err.stale).toBe(true);
      expect(isStaleBuildError(err)).toBe(true);
    });
  }

  it('returns the module untouched when the chunk is there', async () => {
    const mod = { default: 'ExcelJS' };
    await expect(loadModule(() => Promise.resolve(mod), 'the spreadsheet builder')).resolves.toBe(mod);
  });
});

describe('loadModule — what it must NOT swallow', () => {
  // The dangerous failure mode of a catch-all like this: a real bug inside the workbook code
  // gets relabelled "reload the page", the landlord reloads, it happens again, and the actual
  // error is never seen by anyone.
  it('rethrows an unrelated error exactly as it was thrown', async () => {
    const real = new RangeError('Invalid worksheet name: contains []');
    const caught = await loadModule(() => Promise.reject(real), 'the spreadsheet builder').catch((e) => e);
    expect(caught).toBe(real);
    expect(caught).not.toBeInstanceOf(StaleBuildError);
    expect(isStaleBuildError(caught)).toBe(false);
  });

  it('treats a network failure as what it is, not as a stale build', async () => {
    const offline = new TypeError('Failed to fetch');
    const caught = await loadModule(() => Promise.reject(offline), 'the spreadsheet builder').catch((e) => e);
    expect(caught).toBe(offline);
  });

  it('says nothing about junk', () => {
    expect(isStaleBuildError(null)).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
    expect(isStaleBuildError({})).toBe(false);
  });
});
