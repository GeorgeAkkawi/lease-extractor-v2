// Quiet inline "saved · ↩ Undo · ✕" strip shown right after a freely-editable
// save (the Dashboard undo-banner pattern, shrunk inline). Hosts keep one state
// slot { label, undo } where undo is a closure capturing the previous values;
// the strip is component state only — it vanishes on navigation, which is fine
// because these sections stay editable in place.
export default function UndoStrip({ label = 'Saved', onUndo, onDismiss, busy }) {
  return (
    <span className="undo-strip" role="status">
      <span className="undo-note">{label}</span>
      <button type="button" className="ghost btn-sm" onClick={onUndo} disabled={busy}>↩ Undo</button>
      <button type="button" className="icon-btn dismiss-x" title="Dismiss" onClick={onDismiss}>✕</button>
    </span>
  );
}
