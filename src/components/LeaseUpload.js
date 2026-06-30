import { useState } from 'react';
import { uploadAndExtract, extractFromText } from '../lib/api';

const SAMPLE = `COMMERCIAL LEASE AGREEMENT
Tenant: Sunrise Bakery LLC. Premises: Suite 140, approximately 2,400 rentable square feet.
Base Rent: $72,000.00 per annum, payable in equal monthly installments.
Term: Five (5) years commencing September 1, 2025 and expiring August 31, 2030.
Annual Adjustment: Base Rent shall increase by three percent (3%) on each anniversary, first effective September 1, 2026.
Renewal: Tenant shall have one (1) option to renew for five (5) years upon written notice no later than March 1, 2030.`;

// Lease intake by file (PDF/scan/photo/handwritten) OR pasted text — AI extracts.
// Calls onExtracted({ lease_file_id, extraction }).
export default function LeaseUpload({ onExtracted }) {
  const [mode, setMode] = useState('file'); // 'file' | 'text'
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [err, setErr] = useState('');

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    run(() => uploadAndExtract(file), () => { e.target.value = ''; });
  }
  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && !busy) run(() => uploadAndExtract(file));
  }
  async function handleText() {
    if (!text.trim()) return;
    run(() => extractFromText(text.trim()));
  }
  async function run(fn, cleanup) {
    setBusy(true);
    setErr('');
    try {
      onExtracted(await fn());
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
      cleanup?.();
    }
  }

  return (
    <div className="callout">
      <div className="between" style={{ marginBottom: 8 }}>
        <strong style={{ fontFamily: 'var(--display)', fontSize: 19 }}>Add a lease with AI</strong>
        <div className="seg">
          <button className={`seg-btn${mode === 'file' ? ' on' : ''}`} onClick={() => setMode('file')}>Upload file</button>
          <button className={`seg-btn${mode === 'text' ? ' on' : ''}`} onClick={() => setMode('text')}>Paste text</button>
        </div>
      </div>

      {mode === 'file' ? (
        <>
          <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
            PDF, Word (.docx), scan, photo, or handwritten. AI fills the fields with confidence scores and source clauses — you review before saving.
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
            For the most complete extraction, Word docs and PDFs work best — scans and photos work too, just with a little less detail.
          </div>
          {/* Native file input (the browser's own picker) inside a drop zone so a
              file can be chosen by click OR dragged straight in. */}
          <div
            className={`dropzone${dragOver ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept=".pdf,.docx,image/*"
              onChange={handleFile}
              disabled={busy}
              className="file-native"
              aria-label="Choose a lease file from your computer"
            />
            <div className="dropzone-hint muted">
              {busy ? 'Reading document…' : '…or drag & drop a PDF, Word doc, scan, or photo here'}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
            Paste lease text (PDF/scan OCR would feed in here). AI fills the fields with confidence scores — you review before saving.
          </div>
          <textarea className="text-input" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the lease text…" style={{ width: '100%' }} />
          <div className="row" style={{ marginTop: 10 }}>
            <button type="button" className="ghost" onClick={() => setText(SAMPLE)}>Paste sample lease</button>
            <button type="button" onClick={handleText} disabled={busy || !text.trim()}>{busy ? 'Extracting…' : 'Extract with AI'}</button>
          </div>
        </>
      )}
      {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}
