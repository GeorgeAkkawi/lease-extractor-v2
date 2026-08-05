import { useEffect, useRef, useState } from 'react';

// DRAGGING A FILE ONTO THE THING IT BELONGS TO — everywhere a file can be chosen.
//
// George, 2026-08-05: *"make a drag and drop feature for uploading all places you have to
// choose a file."*
//
// Before this there were exactly two drop targets in the app (the lease intake box and the
// bank-statement panel) and eleven other pickers that only opened the OS dialog. This is the
// one implementation all of them now share, so a person who learns to drag a file onto the
// insurance card does not then discover that riders, contracts and documents don't take one.
//
// ⚠ THE ACCEPT FILTER IS NOT DECORATION HERE. The native picker enforces `accept` itself; a
// DROP does not — the browser hands over whatever was dragged, including a folder (which
// arrives as a File with no type and no extension). Without the check below, dropping a .zip
// on the policy card would upload it and spend an AI read on binary. So every drop is matched
// against the SAME accept string the picker uses, and a mismatch says what was expected
// rather than failing somewhere downstream.
//
// Two shapes, because the hosts genuinely differ:
//   • <FilePickerZone>  the visible dashed box — for screens whose whole job is "give me a
//                       file" (lease intake, a policy, a rider, a contract, a send-for-signature)
//   • <FileDrop>        an invisible wrapper — for a card or a list that already has its own
//                       button, so the whole card becomes a target without costing any height
//                       at rest. Nothing is drawn until a file is actually over it.

// Match a dropped file against an `accept` string, using the same rules the browser applies
// to the picker: ".pdf" by extension, "image/*" by mime prefix, "text/csv" exactly.
export function fileMatchesAccept(file, accept) {
  const spec = String(accept || '').trim();
  if (!spec) return true;
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return spec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith('.')) return name.endsWith(rule);
      if (rule.endsWith('/*')) return !!type && type.startsWith(rule.slice(0, -1));
      return !!type && type === rule;
    });
}

// "PDF, DOCX or an image" — what to say when the wrong thing lands. Written out rather than
// echoing the raw accept string, because ".pdf,.docx,image/*" is not a sentence.
export function acceptWords(accept) {
  const parts = String(accept || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((p) => {
      if (p === 'image/*') return 'an image';
      if (p === '.docx') return 'a Word .docx';
      if (p.startsWith('.')) return `a ${p.slice(1).toUpperCase()}`;
      return p;
    });
  const seen = [...new Set(parts)];
  if (!seen.length) return 'a file';
  if (seen.length === 1) return seen[0];
  return `${seen.slice(0, -1).join(', ')} or ${seen[seen.length - 1]}`;
}

// ⚠ A MISS MUST DO NOTHING — never navigate. A file dropped an inch outside a target is the
// browser's cue to leave the app and open that file in the tab, which throws away a half-typed
// form, an unsaved review and every unsaved edit on the page. Mounted once, at the top of the
// app, so it covers every screen including the public signing page.
export function useStrayFileDropGuard() {
  useEffect(() => {
    const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
    // A real target calls preventDefault + stopPropagation? No — it only preventDefaults, and
    // these run at the document level AFTER it, so checking defaultPrevented is what tells a
    // handled drop from a stray one.
    const over = (e) => {
      if (!isFileDrag(e) || e.defaultPrevented) return;
      e.preventDefault();
      // 'none' so the cursor says "not here" everywhere except a real target, which sets
      // 'copy' on its own before this runs.
      try { e.dataTransfer.dropEffect = 'none'; } catch { /* read-only in some browsers */ }
    };
    const drop = (e) => { if (isFileDrag(e) && !e.defaultPrevented) e.preventDefault(); };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);
}

// The drag state and the four handlers. Returned as `dropProps` so a host can spread them
// onto whatever element it already renders instead of gaining a wrapper div.
export function useFileDrop({
  onFile, accept = '', disabled = false, busy = false,
  // What to say when several land at once. A caller with its own word for the thing being
  // dropped ("statement") says it better than "file" does.
  manyMessage = (n) => `${n} files were dropped — add one at a time.`,
}) {
  // dragenter/dragleave fire again for every child the cursor crosses, so a boolean flickers
  // off the moment you move over a row inside the target. Counting enters and leaves is what
  // makes the veil hold steady across a card full of elements.
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState('');

  // Only react to a FILE drag. Dragging selected text, a link, or one of the app's own
  // draggable rows must leave the host alone.
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  const onDragEnter = (e) => {
    if (!isFileDrag(e) || disabled) return;
    depth.current += 1;
    setOver(true);
  };
  const onDragLeave = (e) => {
    if (!isFileDrag(e) || disabled) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setOver(false);
  };
  const onDragOver = (e) => {
    // Without this the browser navigates away and opens the dropped file instead of handing
    // it over — which on a half-filled form loses everything typed.
    if (!isFileDrag(e) || disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current = 0;
    setOver(false);
    if (disabled || busy) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    // One at a time — every one of these hosts reads and reviews a single document, and
    // quietly taking the first of five would look like all five had been taken.
    if (files.length > 1) {
      setErr(manyMessage(files.length));
      return;
    }
    if (!fileMatchesAccept(files[0], accept)) {
      setErr(`“${files[0].name}” isn’t something this can read. Drop ${acceptWords(accept)}.`);
      return;
    }
    setErr('');
    onFile(files[0]);
  };

  return { over, err, setErr, dropProps: { onDragEnter, onDragLeave, onDragOver, onDrop } };
}

// The invisible wrapper: any region becomes a target, and says so only while a file is over it.
export default function FileDrop({
  onFile, accept = '', disabled = false, busy = false,
  title = 'Drop the file here', hint = '', className = '', children,
}) {
  const { over, err, dropProps } = useFileDrop({ onFile, accept, disabled, busy });
  return (
    <div className={`filedrop ${className}`.trim()} {...dropProps}>
      {children}
      {over && !disabled && (
        // pointer-events:none in the CSS — the veil must never become the drag target itself,
        // or entering it would read as leaving the host and the depth count would lie.
        <div className="filedrop-veil" aria-hidden="true">
          <strong>{title}</strong>
          {hint && <span>{hint}</span>}
        </div>
      )}
      {err && <p className="note-msg danger" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// The visible box: the browser's own picker, and the same target for a drag. Both doors are
// drawn at once because a person who has never dragged a file has to be able to see the button.
export function FilePickerZone({
  onFile, accept = '', disabled = false, busy = false,
  hint = 'Choose a file', dropHint = 'Drop it here', busyHint = '', ariaLabel = 'Choose a file',
  children,
}) {
  const { over, err, dropProps } = useFileDrop({ onFile, accept, disabled, busy });
  return (
    <div className={`dropzone filedrop-zone${over && !disabled ? ' over' : ''}`} {...dropProps}>
      <input
        type="file" accept={accept} className="file-native" disabled={disabled || busy}
        aria-label={ariaLabel}
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Cleared before the handler runs, so choosing the SAME file twice still fires a
          // change event — the difference between "nothing happened" and a second read.
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      <div className="dropzone-hint muted">
        {busy ? (busyHint || 'Reading…') : over && !disabled ? <strong>{dropHint}</strong> : hint}
      </div>
      {children}
      {err && <p className="note-msg danger" style={{ marginTop: 4, marginBottom: 0 }}>{err}</p>}
    </div>
  );
}
