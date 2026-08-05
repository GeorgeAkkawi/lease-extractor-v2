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
  const ghostRef = useRef(null);
  const dragRef = useRef(null);       // the live drag; a ref, never state — see below
  const clickBlockRef = useRef(false);
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

  // The signature's size on screen, in CSS pixels — what a drag has to carry around before
  // there is any placement to measure.
  const sigBox = geom ? {
    w: (DEFAULT_SIG_WIDTH_PT / geom.pageW) * geom.boxW,
    h: (sigHeight(DEFAULT_SIG_WIDTH_PT, imgDims?.w, imgDims?.h) / geom.pageH) * geom.boxH,
  } : null;

  // Commit a CENTRE point, in CSS pixels measured from the page's top-left, as a placement.
  function commit(cssX, cssY) {
    if (!geom) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pt = dropToPdfPoint({
      cssX,
      cssY,
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

  // A tap drops the signature where you tapped. Kept alongside the drag below because on a
  // phone a tap is what people actually do, and because it is the path that survives when
  // pointer events don't fire (an old browser, a screen reader driving the page).
  function place(e) {
    if (disabled || !signature || !geom) return;
    if (clickBlockRef.current) return;   // a drag just ended here; it has already committed
    const rect = canvasRef.current.getBoundingClientRect();
    commit(e.clientX - rect.left, e.clientY - rect.top);
  }

  // ── The drag ────────────────────────────────────────────────────────────────────────────
  // George, 2026-08-04: *"the drag feature for the sign needs to be more fluid."* It was:
  // tap to place, then a "Move it" button, then tap again. Now the mark follows the finger.
  //
  // ⚠ THE MOVE HANDLER WRITES TO THE DOM DIRECTLY AND DELIBERATELY. Re-rendering React on
  // every pointermove — 120/second on a modern phone — is what made the old version feel
  // sticky. The drag lives in a ref, the ghost's transform is set on the element itself, and
  // React is told about it exactly twice: once when the drag starts, once when it ends.
  const EDGE_PT = 4;   // mirrors EDGE in signPlacement.js, so the ghost lands where it lands
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

  const paintGhost = (left, top) => {
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${left}px, ${top}px)`;
  };

  function onPointerDown(e) {
    clickBlockRef.current = false;   // never let a stale block swallow a later tap
    if (disabled || !signature || !geom || !sigBox) return;
    if (typeof e.button === 'number' && e.button > 0) return;   // right / middle click
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const w = mine?.width || sigBox.w;
    const h = mine?.height || sigBox.h;
    // Grabbing your own mark keeps the grip point under your finger; starting anywhere else
    // picks it up by its middle, which is where someone aims when they mean "here".
    const onMine = !!mine
      && px >= mine.left && px <= mine.left + mine.width
      && py >= mine.top && py <= mine.top + mine.height;
    dragRef.current = {
      id: e.pointerId, w, h, onMine, moved: false,
      startX: px, startY: py,
      dx: onMine ? px - mine.left : w / 2,
      dy: onMine ? py - mine.top : h / 2,
      left: onMine ? mine.left : px - w / 2,
      top: onMine ? mine.top : py - h / 2,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  }

  function onPointerMove(e) {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId || !geom) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (!d.moved && Math.hypot(px - d.startX, py - d.startY) < 3) return;  // a shaky tap
    const edgeX = (EDGE_PT / geom.pageW) * rect.width;
    const edgeY = (EDGE_PT / geom.pageH) * rect.height;
    d.left = clamp(px - d.dx, edgeX, rect.width - d.w - edgeX);
    d.top = clamp(py - d.dy, edgeY, rect.height - d.h - edgeY);
    paintGhost(d.left, d.top);
    if (!d.moved) { d.moved = true; setDragging(true); }
    if (e.cancelable) e.preventDefault();
  }

  function endDrag(e, keep) {
    const d = dragRef.current;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (!d || d.id !== e.pointerId) return;
    if (d.moved) setDragging(false);
    // A drag has already decided where the mark goes; a tap on your own mark means "I'm
    // holding this", not "move it here". Either way the click that follows must not re-place.
    if (d.moved || d.onMine) clickBlockRef.current = true;
    if (d.moved && keep) commit(d.left + d.w / 2, d.top + d.h / 2);
  }

  if (phase === 'failed') return null; // the caller shows its own fallback

  // ── SAYING WHAT TO DO, WHERE IT IS LOOKED AT ────────────────────────────────────────────
  // George, 2026-08-05: *"make the prompt for the signature signing and placing way more
  // obvious right now its hidden theres needs to be clear instructions."* It WAS said — in a
  // 12.5px grey line under a 150px signature pad, below a document box up to 70vh tall. By
  // the time a signer has drawn their mark, the instruction telling them what to do with it
  // is off the bottom of the screen and the document it refers to is off the top.
  //
  // So the instruction now lives ABOVE the scroll box, outside it, and changes with the
  // state: it cannot be scrolled away from, and it always names the next action rather than
  // describing the feature. The floating pill inside the page is the second half of the same
  // sentence, sitting where the tap has to land.
  const step = !signature ? 'sign' : !placement ? 'place' : 'done';
  const stepText = {
    sign: 'Read the document, then add your signature below — you will drop it on the page here.',
    place: 'Tap the signature line — anywhere on the page — and your signature lands there.',
    done: `Your signature is on page ${placement?.page}. Drag it to move it, or tap somewhere else.`,
  }[step];

  return (
    <div className="pdfsign">
      <div className={`pdfsign-step ${step}`} role="status">
        <span className="pdfsign-step-n" aria-hidden="true">{step === 'done' ? '✓' : step === 'place' ? '2' : '1'}</span>
        <span>{stepText}</span>
      </div>
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
            title="Take your signature back off the page. To move it, just drag it.">
            Take it off
          </button>
        )}
      </div>

      <div className="pdfsign-wrap" ref={wrapRef}>
        <div
          className={`pdfsign-stage${signature && !disabled ? ' placing' : ''}${dragging ? ' dragging' : ''}${step === 'place' && !disabled ? ' awaiting' : ''}`}
          style={geom ? { width: geom.boxW, height: geom.boxH } : undefined}
          onClick={place}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, true)}
          onPointerCancel={(e) => endDrag(e, false)}
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

          {/* The signer's own mark, where they put it. Hidden while it is being dragged —
              the ghost below is the one under their finger. */}
          {mine && signature && (
            <img src={signature} alt="Your signature" className="pdfsign-placed mine"
              style={{
                left: mine.left, top: mine.top, width: mine.width, height: mine.height,
                visibility: dragging ? 'hidden' : 'visible',
              }} />
          )}

          {/* The thing that follows the finger. Positioned by `transform` written straight to
              the element — React never re-renders during a drag, which is the whole point. */}
          {signature && !disabled && (
            <img ref={ghostRef} src={signature} alt="" aria-hidden="true"
              className={`pdfsign-ghost${dragging ? ' on' : ''}`}
              style={{ width: mine?.width || sigBox?.w || 0, height: mine?.height || sigBox?.h || 0 }} />
          )}

          {/* The prompt, only while there is a signature to place and nowhere to put it yet.
              ⚠ Pinned to the TOP of the page, not its middle. The scroll box opens at the top
              of the page, so a hint centred on a full sheet of A4 starts below the fold — it
              was, quite literally, hidden. */}
          {signature && !placement && !disabled && !dragging && (
            <div className="pdfsign-hint">
              <strong>👆 Tap where your signature goes</strong>
              <span>Look for the signature line. You can drag it afterwards to line it up.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
