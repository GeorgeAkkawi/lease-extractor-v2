import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { useModalA11y } from './modalA11y';

// A professional, branded "Are you sure?" dialog with the consequences of a destructive
// action listed in a highlighted box — the replacement for the browser's bare
// window.confirm() on every delete / permanent-removal / undo (George, 2026-07-24:
// "needs to be an are you sure when deleting things and the implications listed …
// a professional looking pop-up window with implications highlighted").
//
// Used imperatively so a call site stays a one-liner and no component has to hold modal
// state itself:
//   const askConfirm = useConfirm();
//   onClick={async () => { if (await askConfirm({ title, message, implications })) remove.mutate(id); }}
//
// `askConfirm(opts)` resolves true on confirm, false on cancel/Escape/scrim/✕.
//   opts: { title, message, implications: string[], confirmLabel, cancelLabel,
//           tone: 'danger' | 'warn' | 'default', choices?: [{ key, label, hint, tone }] }
// tone drives severity: 'danger' (red, the default — permanent deletes), 'warn' (gold —
// reversible/undo-able), 'default' (accent — consequential but not destructive).
//
// ⚠ `choices` MAKES IT A FORK RATHER THAN A YES/NO, and it resolves to the chosen KEY instead
// of `true` (cancel still resolves `false`, so `if (await askConfirm(...))` keeps working —
// a key is truthy). It exists because some decisions genuinely have three ways forward and
// forcing them into "OK / Cancel" makes the third one invisible: closing a year over open
// balances can carry them all forward, leave them frozen, or send the landlord to settle them
// one at a time (2026-08-16). Each choice states its own consequence under its label, because
// the whole point is that they differ.

const ConfirmContext = createContext(() => Promise.resolve(false));

export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }) {
  const [opts, setOpts] = useState(null);
  const resolveRef = useRef(null);

  const askConfirm = useCallback(
    (options = {}) =>
      new Promise((resolve) => {
        resolveRef.current = resolve;
        setOpts({
          title: options.title || 'Are you sure?',
          message: options.message || '',
          implications: Array.isArray(options.implications) ? options.implications.filter(Boolean) : [],
          confirmLabel: options.confirmLabel || 'Delete',
          cancelLabel: options.cancelLabel || 'Cancel',
          tone: options.tone || 'danger',
          choices: Array.isArray(options.choices) ? options.choices.filter((c) => c && c.key) : [],
        });
      }),
    []
  );

  const settle = useCallback((value) => {
    setOpts(null);
    const r = resolveRef.current;
    resolveRef.current = null;
    r?.(value);
  }, []);

  return (
    <ConfirmContext.Provider value={askConfirm}>
      {children}
      {opts && <ConfirmDialog {...opts} onCancel={() => settle(false)} onConfirm={() => settle(true)} onChoose={settle} />}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({ title, message, implications, confirmLabel, cancelLabel, tone, choices = [], onCancel, onConfirm, onChoose }) {
  // Escape / focus-trap; opens focus on the first control (the ✕, i.e. cancel) so an
  // accidental Enter never deletes.
  const modalRef = useModalA11y(onCancel);
  const impTone = tone === 'warn' ? ' warn' : tone === 'default' ? ' info' : '';
  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div
        className="modal"
        ref={modalRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong>{title}</strong>
          <button className="icon-btn" onClick={onCancel} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">
          {message && <p className="confirm-msg">{message}</p>}
          {implications.length > 0 && (
            <div className={`confirm-imp${impTone}`}>
              <p className="confirm-imp-title">What this does</p>
              <ul>
                {implications.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {choices.length > 0 ? (
            // Stacked, full-width, each stating its own consequence — because they differ, and
            // a row of three equal buttons makes the reader guess which one is the safe default.
            <div className="confirm-choices">
              {choices.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`confirm-choice${c.tone === 'primary' ? ' is-primary' : ''}`}
                  onClick={() => onChoose(c.key)}
                >
                  <span className="confirm-choice-label">{c.label}</span>
                  {c.hint && <span className="confirm-choice-hint">{c.hint}</span>}
                </button>
              ))}
              <div className="modal-actions" style={{ justifyContent: 'flex-end' }}>
                <button className="secondary" onClick={onCancel}>{cancelLabel}</button>
              </div>
            </div>
          ) : (
            <div className="modal-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={onCancel}>{cancelLabel}</button>
              <button className={tone === 'danger' ? 'danger-solid' : undefined} onClick={onConfirm}>
                {confirmLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
