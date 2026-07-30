import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listDocuments, deleteDocument, uploadDoc, signDocUrl } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useConfirm } from './ConfirmDialog';

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

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setErr('');
    try {
      await uploadDoc(file, { entityType, entityId });
      refresh();
    } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
  }

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

  if (!entityId) return null;

  return (
    <div className="doc-list">
      <div className="doc-list-head">
        <strong>{title}</strong>
        <button type="button" className="ghost btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Saving…' : `⬆ ${addLabel}`}
        </button>
        <input ref={fileRef} type="file" accept={accept} style={{ display: 'none' }} onChange={onFile} aria-label={`Add a document to this ${entityType.replace(/_/g, ' ')}`} />
      </div>

      {err && <p className="note-msg danger" style={{ margin: '6px 0 0' }}>{err}</p>}

      {!isLoading && docs.length === 0 && (
        <p className="muted doc-list-empty">{emptyText}</p>
      )}

      {docs.map((d, i) => (
        <div className="doc-row" key={d.id}>
          <span className="doc-row-name" title={d.filename || d.storage_path}>
            {d.filename || d.label || 'Document'}
            {/* Everything after the first is an earlier copy — say so, so a list of
                seven identically-named uploads reads as history rather than a mess. */}
            {i > 0 && <span className="muted doc-row-older"> · earlier copy</span>}
          </span>
          <span className="muted doc-row-meta">
            {[humanBytes(d.bytes), fmtDate(d.created_at)].filter(Boolean).join(' · ')}
          </span>
          <button type="button" className="ghost btn-sm" onClick={() => open(d.storage_path)}>Open</button>
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
        </div>
      ))}
    </div>
  );
}
