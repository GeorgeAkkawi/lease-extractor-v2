import { useCallback, useEffect, useRef, useState } from 'react';
import { dropToPdfPoint, pdfPointToBox, DEFAULT_SIG_WIDTH_PT, sigHeight } from '../lib/signPlacement';

// The document, with signatures on it. Used in exactly two places and it is the same
// component in both, which is what keeps drag-to-sign from being two builds:
//
//   • the tenant's public signing page — they drop their own mark on the signature line
//   • the landlord's countersign dialog — same document, with the TENANT'S signature already
//     drawn where they put it, so he sees their placement before committing his own
//
// George, 2026-08-04: *"drag and drop signature feature? on the pdf on the tenants side that
// automatically copies it down and send it back as a real signature on the actual pdf
// document? same thing for the countersign."*
//
// ⚠ IT MUST NEVER BLOCK SIGNING. pdf.js is lazy-loaded over the network, needs a Web Worker,
// and will simply fail on some documents (a corrupt scan, a password-protected file, an old
// mobile browser). Every one of those paths ends in `failed`, which tells the caller to fall
// back to signing WITHOUT placement — the executed PDF then appends a signature page exactly
// as it did before this feature existed. A tenant who cannot see the document must still be
// able to sign it.
//
// All coordinate maths lives in src/lib/signPlacement.js — pure, and tested at four page
// rotations. Nothing in this file does arithmetic on a PDF point.

export default function PdfSignCanvas({
  url,                 // the document
  signature,           // the signer's PNG data URL; null until they've drawn/typed one
  placement,           // { page, x, y, w } | null — where THEY have put it so far
  onPlace,             // (placement | null) => void
  existing = [],       // [{ png, place_page, place_x, place_y, place_w, label }] already signed
  disabled = false,
  onFail,              // called once if the document can't be rendered at all
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const pdfRef = useRef(null);
  const [pageNum, setPageNum] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [geom, setGeom] = useState(null);   // { boxW, boxH, pageW, pageH, rotation }
  const [phase, setPhase] = useState('loading'); // loading | ready | failed
  const [imgDims, setImgDims] = useState(null);
  const [dragging, setDragging] = useState(false);

  // The signature's natural size, so a placed mark keeps its own proportions rather than
  // being forced into a fixed box.
  useEffect(() => {
    if (!signature) { setImgDims(null); return undefined; }
    let live = true;
    const img = new Image();
    img.onload = () => { if (live) setImgDims({ w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = signature;
    return () => { live = false; };
  }, [signature]);

  // Open the document once. Everything is lazy: pdf.js isn't downloaded until this runs.
  useEffect(() => {
    if (!url) { setPhase('failed'); onFail?.(); return undefined; }
    let live = true;
    (async () => {
      try {
        const { openPdf } = await import('../lib/pdfRender');
        const pdf = await openPdf(url);
        if (!live) return;
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);
        setPhase('ready');
      } catch {
        if (!live) return;
        setPhase('failed');
        onFail?.();
      }
    })();
    return () => { live = false; };
    // onFail is deliberately not a dep — a parent re-render must not reopen the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Draw the current page, and redraw on resize so the overlay and the canvas never disagree
  // about where the page is (a stale box is how a signature ends up 40pt off).
  const draw = useCallback(async () => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!pdf || !canvas || !wrap) return;
    try {
      const { renderPage } = await import('../lib/pdfRender');
      const width = Math.max(240, wrap.clientWidth);
      setGeom(await renderPage(pdf, pageNum, canvas, width));
    } catch {
      setPhase('failed');
      onFail?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageNum]);

  useEffect(() => { if (phase === 'ready') draw(); }, [phase, draw]);

  useEffect(() => {
    if (phase !== 'ready') return undefined;
    let t = null;
    const onResize = () => { clearTimeout(t); t = setTimeout(draw, 120); };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(t); window.removeEventListener('resize', onResize); };
  }, [phase, draw]);

  // A click or a drag-release anywhere on the page places the signature there. Both, because
  // on a phone "drag" is fiddly and a tap is what people actually do.
  function place(e) {
    if (disabled || !signature || !geom) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const pt = dropToPdfPoint({
      cssX: e.clientX - rect.left,
      cssY: e.clientY - rect.top,
      boxW: rect.width,
      boxH: rect.height,
      pageW: geom.pageW,
      pageH: geom.pageH,
      width: DEFAULT_SIG_WIDTH_PT,
      imgW: imgDims?.w,
      imgH: imgDims?.h,
    });
    onPlace({ page: pageNum, x: pt.x, y: pt.y, w: pt.w });
  }

  // Where to draw something that's already placed on THIS page, in CSS pixels.
  const boxFor = (p, w, h) => (
    !geom || !p || p.page !== pageNum ? null : pdfPointToBox({
      x: p.x, y: p.y, w: p.w, h, pageW: geom.pageW, pageH: geom.pageH,
      boxW: geom.boxW, boxH: geom.boxH,
    })
  );

  const mine = placement?.page === pageNum
    ? boxFor(placement, placement.w, sigHeight(placement.w, imgDims?.w, imgDims?.h))
    : null;

  if (phase === 'failed') return null; // the caller shows its own fallback

  return (
    <div className="pdfsign">
      <div className="pdfsign-bar">
        <button type="button" className="ghost btn-sm" disabled={pageNum <= 1}
          onClick={() => setPageNum((n) => Math.max(1, n - 1))}>‹ Back</button>
        <span className="muted" style={{ fontSize: 12 }}>
          {phase === 'loading' ? 'Loading…' : `Page ${pageNum} of ${pageCount}`}
        </span>
        <button type="button" className="ghost btn-sm" disabled={pageNum >= pageCount}
          onClick={() => setPageNum((n) => Math.min(pageCount, n + 1))}>Next ›</button>
        {placement && (
          <button type="button" className="ghost btn-sm" disabled={disabled}
            onClick={() => onPlace(null)}
            title="Remove your signature from the page and place it somewhere else">
            Move it
          </button>
        )}
      </div>

      <div className="pdfsign-wrap" ref={wrapRef}>
        <div
          className={`pdfsign-stage${signature && !disabled ? ' placing' : ''}`}
          style={geom ? { width: geom.boxW, height: geom.boxH } : undefined}
          onClick={place}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); place(e); }}
        >
          <canvas ref={canvasRef} className="pdfsign-canvas" />

          {/* Signatures already committed by someone else — the tenant's, seen by the
              landlord before he countersigns. Not draggable: they are a record. */}
          {existing.filter((s) => s.png && s.place_page === pageNum).map((s, i) => {
            const b = boxFor(
              { page: s.place_page, x: s.place_x, y: s.place_y, w: s.place_w },
              s.place_w,
              sigHeight(s.place_w, s.imgW, s.imgH),
            );
            return b && (
              <img key={i} src={s.png} alt={s.label || 'Signature'} className="pdfsign-placed done"
                style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />
            );
          })}

          {/* The signer's own mark, where they put it. */}
          {mine && signature && (
            <img src={signature} alt="Your signature" className="pdfsign-placed mine"
              style={{ left: mine.left, top: mine.top, width: mine.width, height: mine.height }} />
          )}

          {/* The prompt, only while there is a signature to place and nowhere to put it yet. */}
          {signature && !placement && !disabled && (
            <div className={`pdfsign-hint${dragging ? ' over' : ''}`}>
              Tap or drag your signature onto the signature line
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
