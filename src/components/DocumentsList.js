import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listDocuments, deleteDocument, uploadDoc, signDocUrl, markDocumentSigned, unmarkDocumentSigned } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useConfirm } from './ConfirmDialog';
import FileDrop from './FileDrop';

// Every copy kept for one record — the version history George asked for
// (2026-07-30: "keep every version but allow deletes").
//
// One component for all five record types, because they all had the same problem:
// the file was uploaded, read once, and then unreachable. The registry (documents,
// migration 0070) is what makes one list possible; this renders it.
//
// Nothing auto-deletes. Re-uploading a lease adds a version rather than replacing
// one, and the only way a saved document leaves is the ✕ — behind the standard
// ConfirmDialog, naming exactly what goes.

const humanBytes = (n) => {
  const b = Number(n);
  if (!b || b < 0) return null;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
};

// Used by INSURANCE POLICIES and SERVICE CONTRACTS only. The lease and its riders left
// this list on 2026-08-04: they each hold one document and now render it as a single row
// (LeaseDocs / RiderDocs), which is what let the panel say "Read text" and "Open file" in
// the same shape everywhere. A policy or contract keeps the list — an endorsement really
// is another file on the same record — and keeps its always-on add with it.
export default function DocumentsList({
  entityType,
  entityId,
  title = 'Documents',
  addLabel = 'Add',
  emptyText = 'No copies saved yet.',
  accept = '.pdf,.docx,image/*',
}) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const key = ['documents', entityType, entityId];
  const { data: docs = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => listDocuments(entityType, entityId),
    enabled: !!entityId,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const remove = useMutation({
    mutationFn: (id) => deleteDocument(id),
    onSuccess: refresh,
    onError: (e) => setErr(e.message || String(e)),
  });

  // 0092 — designate a copy as THE SIGNED one. Keyed by document id, so it works for a
  // contract, a policy or anything else that files here; the record's own panel then shows
  // it. Deliberately not exclusive: an amended agreement has an original signed copy and a
  // signed amendment, and picking one for the landlord would be wrong.
  const sign = useMutation({
    mutationFn: ({ id, on }) => (on ? markDocumentSigned(id) : unmarkDocumentSigned(id)),
    onSuccess: refresh,
    onError: (e) => setErr(e.message || String(e)),
  });

  async function onFile(file) {
    if (!file) return;
    setBusy(true); setErr('');
    try {
      await uploadDoc(file, { entityType, entityId });
      refresh();
    } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
  }
  const onPicked = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onFile(f); };

  // The bucket is private, so opening a document means minting a short-lived signed
  // URL first (signDocUrl, 120s). Opened in a new tab so the app keeps its state.
  async function open(path) {
    setErr('');
    try {
      const url = await signDocUrl(path);
      if (url) window.open(url, '_blank', 'noopener');
      else setErr('That file is no longer in storage.');
    } catch (ex) { setErr(ex.message || String(ex)); }
  }

  // Signed copies first — the executed document is what somebody opening this list is
  // almost always looking for. Within each group, newest first as before.
  const ordered = [...docs].sort((a, b) => (a.signed_at ? 0 : 1) - (b.signed_at ? 0 : 1));

  if (!entityId) return null;

  return (
    // The whole list is the drop target — dropping a file onto a list of copies is the
    // most natural way to say "here is another one", and it costs no height at rest.
    <FileDrop
      onFile={onFile}
      accept={accept}
      busy={busy}
      className="doc-list"
      title={`Drop to ${addLabel.toLowerCase()}`}
      hint="It is filed with the copies already here — nothing is replaced."
    >
      <div className="doc-list-head">
        <strong>{title}</strong>
        <span className="doc-actions">
          <button type="button" className="ghost btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}
            title="Choose a file — or drag one anywhere onto this list">
            {busy ? 'Saving…' : `⬆ ${addLabel}`}
          </button>
          <span className="doc-act2" />
        </span>
        <input ref={fileRef} type="file" accept={accept} style={{ display: 'none' }} onChange={onPicked} aria-label={`Add a document to this ${entityType.replace(/_/g, ' ')}`} />
      </div>

      {err && <p className="note-msg danger" style={{ margin: '6px 0 0' }}>{err}</p>}

      {!isLoading && docs.length === 0 && (
        <p className="muted doc-list-empty">{emptyText}</p>
      )}

      {ordered.map((d, i) => (
        <div className="doc-row" key={d.id}>
          <span className="doc-row-name" title={d.filename || d.storage_path}>
            {d.filename || d.label || 'Document'}
            {/* Everything after the first is an earlier copy — say so, so a list of
                seven identically-named uploads reads as history rather than a mess. */}
            {d.signed_at && <span className="badge good" style={{ marginLeft: 6 }}>Signed copy</span>}
            {i > 0 && !d.signed_at && <span className="muted doc-row-older"> · earlier copy</span>}
          </span>
          <span className="muted doc-row-meta">
            {[humanBytes(d.bytes), fmtDate(d.created_at)].filter(Boolean).join(' · ')}
          </span>
          <span className="doc-actions">
            {/* "Open file" everywhere a real document opens, never a bare "Open" — the
                panel also has "Read text", and the whole point of the pair is that you
                can tell at a glance which one gives you the signed PDF. */}
            <button type="button" className="ghost btn-sm" onClick={() => open(d.storage_path)}>Open file</button>
            <button
              type="button" className="ghost btn-sm" disabled={sign.isPending}
              title={d.signed_at ? 'This copy is marked as the signed one' : 'Mark this copy as the signed one'}
              onClick={() => sign.mutate({ id: d.id, on: !d.signed_at })}
            >{d.signed_at ? 'Unmark signed' : 'Mark signed'}</button>
            <span className="doc-act2">
          <button
            type="button" className="icon-btn danger-btn" title="Delete this copy"
            disabled={remove.isPending}
            onClick={async () => {
              if (await askConfirm({
                title: 'Delete this copy?',
                message: `“${d.filename || 'This document'}” will be removed from storage.`,
                implications: [
                  'The file itself is permanently deleted — this can’t be undone.',
                  'Everything the AI already read from it stays: the cached text, the extracted terms and the record itself are untouched.',
                  docs.length > 1 ? 'The other saved copies of this record are not affected.' : 'This is the only copy on file.',
                ],
                confirmLabel: 'Delete copy',
                tone: 'danger',
              })) remove.mutate(d.id);
            }}
          >✕</button>
            </span>
          </span>
        </div>
      ))}
    </FileDrop>
  );
}
