import { isStaleBuildError } from '../lib/lazyModule';

// What a screen shows when an on-demand download failed — and, when the reason is that the
// app was redeployed under an open tab (lazyModule.js), the one action that fixes it.
//
// Shared rather than copied into each export dialog: two copies of "here is the error, here
// is the button" drift into two wordings and one of them ends up without the button.
//
// ⚠ The TONE carries the distinction. A stale build is gold, not red: nothing failed and
// nothing was lost — the app moved while the page stayed still. Red is reserved for a
// workbook that genuinely could not be built, which is a different sentence and a different
// next step (tell George, not reload).
export default function StaleBuildNotice({ error, fallback = 'Could not build the workbook — please try again.' }) {
  if (!error) return null;
  const stale = isStaleBuildError(error);
  const message = (typeof error === 'string' ? error : error?.message) || fallback;
  return (
    <p className={`note-msg ${stale ? 'warn' : 'danger'}`} style={{ marginTop: 12 }}>
      {message}
      {stale && (
        <button type="button" className="btn-sm" style={{ marginLeft: 10 }}
          onClick={() => window.location.reload()}>
          Reload now
        </button>
      )}
    </p>
  );
}
