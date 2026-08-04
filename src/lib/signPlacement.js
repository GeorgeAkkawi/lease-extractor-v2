// Where a dragged signature actually lands on the page — the maths, with no pdf.js and no
// React anywhere near it, because pdf.js cannot render in jsdom and this is the part that
// must be provably right.
//
// ── THE ONE THING TO UNDERSTAND BEFORE CHANGING ANY OF THIS ──────────────────────────────
// Three coordinate systems are in play and two of them disagree:
//
//   1. THE BROWSER — origin top-left, y grows DOWNWARD, units = CSS pixels at whatever scale
//      the page happens to be rendered at.
//   2. pdf.js VIEWPORT SPACE — its `convertToPdfPoint()` hands back PDF points with the
//      origin bottom-left, having ALREADY undone both the render scale and the page's
//      /Rotate. This is what we store.
//   3. pdf-lib DRAWING SPACE — origin bottom-left, points… but it draws in the page's
//      **UNROTATED** space and ignores /Rotate entirely.
//
// So on a page with no rotation, 2 and 3 are identical and everything is easy. On a scanned
// lease carrying /Rotate 90 — which is extremely common, because that is what a sideways scan
// produces — they are NOT, and a signature stored from the browser will stamp in the wrong
// corner. `toUnrotated()` below is the bridge, and it is the reason this module exists as a
// separate testable thing rather than as four lines inside the edge function.
//
// Everything is stored as the signature box's BOTTOM-LEFT corner in PDF points, plus a width.
// The height is never stored — it is derived from the image's own aspect ratio at stamp time,
// so a signature can never come back squashed.

// A dropped signature's default width, in PDF points. ~2.4 inches: wide enough to read on a
// printed page, narrow enough to sit on a normal signature line without covering the name
// printed under it.
export const DEFAULT_SIG_WIDTH_PT = 170;

// Never let a signature be dropped so close to an edge that it hangs off the page. 4pt of
// breathing room, which is under a millimetre — enough to stop a clipped mark, not enough to
// stop someone signing right at the bottom of the page where signature lines actually are.
const EDGE = 4;

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// The height a signature image occupies once drawn `width` points wide. Falls back to a 3:1
// box when the image hasn't reported its dimensions yet (it hasn't decoded, or a test stub
// gave us nothing) rather than producing NaN and drawing nothing at all.
export function sigHeight(width, imgW, imgH) {
  const w = num(width, DEFAULT_SIG_WIDTH_PT);
  const iw = num(imgW, 0);
  const ih = num(imgH, 0);
  if (iw > 0 && ih > 0) return (ih / iw) * w;
  return w / 3;
}

// Keep the whole signature box on the page. Clamps the BOTTOM-LEFT corner so that the box —
// not just its corner — stays inside. A box wider or taller than the page is pinned to the
// bottom-left rather than pushed off the opposite edge.
export function clampToPage({ x, y, w, h }, pageW, pageH) {
  const width = num(w, DEFAULT_SIG_WIDTH_PT);
  const height = num(h, width / 3);
  const maxX = Math.max(EDGE, num(pageW) - width - EDGE);
  const maxY = Math.max(EDGE, num(pageH) - height - EDGE);
  return {
    x: Math.min(Math.max(num(x), EDGE), maxX),
    y: Math.min(Math.max(num(y), EDGE), maxY),
    w: width,
    h: height,
  };
}

// Browser drop point → PDF points, WITHOUT pdf.js. Used when the caller has a plain rendered
// image rather than a live pdf.js viewport (the demo, and every test), and as the reference
// implementation that `viewport.convertToPdfPoint()` is checked against.
//
// `cssX/cssY` are measured from the TOP-LEFT of the rendered page box and are the point the
// user dropped on — treated as the signature's CENTRE, because someone dragging a chip aims
// its middle at the line, not its bottom-left corner.
export function dropToPdfPoint({ cssX, cssY, boxW, boxH, pageW, pageH, width, imgW, imgH }) {
  const bw = num(boxW, 1) || 1;
  const bh = num(boxH, 1) || 1;
  const pw = num(pageW, 612);
  const ph = num(pageH, 792);
  const w = num(width, DEFAULT_SIG_WIDTH_PT);
  const h = sigHeight(w, imgW, imgH);
  // Scale is derived from the rendered box rather than passed in, so a browser zoom, a
  // responsive width or a device-pixel-ratio change can't desync it.
  const centreXPt = (num(cssX) / bw) * pw;
  // Flip the axis: the browser measures down from the top, PDF measures up from the bottom.
  const centreYPt = ph - (num(cssY) / bh) * ph;
  return clampToPage({ x: centreXPt - w / 2, y: centreYPt - h / 2, w, h }, pw, ph);
}

// PDF points → a CSS box for drawing the placed signature back on screen. The exact inverse
// of dropToPdfPoint, and what lets the countersign screen show the tenant's signature sitting
// where they actually put it.
export function pdfPointToBox({ x, y, w, h, pageW, pageH, boxW, boxH }) {
  const pw = num(pageW, 612) || 1;
  const ph = num(pageH, 792) || 1;
  const bw = num(boxW, 1);
  const bh = num(boxH, 1);
  const width = num(w, DEFAULT_SIG_WIDTH_PT);
  const height = num(h, width / 3);
  return {
    left: (num(x) / pw) * bw,
    // Back to top-down, from the box's TOP edge — so subtract the top of the signature,
    // which is y + height, not y.
    top: ((ph - (num(y) + height)) / ph) * bh,
    width: (width / pw) * bw,
    height: (height / ph) * bh,
  };
}

// ── The bridge between pdf.js and pdf-lib ───────────────────────────────────────────────
// A point stored in VIEWPORT space (rotation already applied by pdf.js) converted into the
// page's UNROTATED space, which is the only space pdf-lib will draw in.
//
// `pageW`/`pageH` are the page's box as pdf-lib reports it — i.e. UNROTATED. pdf.js's
// viewport reports the ROTATED box, so for 90/270 the two are swapped, which is exactly the
// trap: passing the wrong pair produces a placement that is subtly wrong rather than
// obviously broken.
//
// Returns { x, y, w, h, angle } where `angle` is the rotation the image itself must be drawn
// at so the signature reads the right way up on the rotated page.
export function toUnrotated({ x, y, w, h }, rotation, pageW, pageH) {
  const r = ((num(rotation) % 360) + 360) % 360;
  const width = num(w, DEFAULT_SIG_WIDTH_PT);
  const height = num(h, width / 3);
  const pw = num(pageW, 612);
  const ph = num(pageH, 792);
  const px = num(x);
  const py = num(y);

  // 0° — the common case, and the two spaces are the same space.
  if (r === 0) return { x: px, y: py, w: width, h: height, angle: 0 };

  if (r === 180) {
    // Rotated a half turn: both axes invert about the page centre, and the mark has to be
    // drawn upside-down to read correctly once the viewer applies /Rotate.
    return { x: pw - px - width, y: ph - py - height, w: width, h: height, angle: 180 };
  }

  // 90 / 270 — the viewport's page box is the unrotated one with its sides swapped, so the
  // viewport width the browser measured against is `ph`, and its height is `pw`.
  if (r === 90) {
    // pdf-lib draws a 90°-rotated image anchored at the point it is given, extending up and
    // left, so the anchor is the box's bottom-RIGHT in unrotated space.
    return { x: px + height, y: py, w: width, h: height, angle: 90 };
  }
  // 270
  return { x: pw - py - height, y: ph - px - width, w: width, h: height, angle: 270 };
}

// Is there anything to stamp? A signer row is "placed" only when it carries a real page and a
// real point — a half-written row (page but no x, say) must fall back to the appended
// signature page rather than stamping at 0,0, which would put a signature in the corner of
// page 1 of somebody's lease.
//
// ⚠ THE null CHECK IS NOT REDUNDANT. `Number(null)` is 0 and `Number.isFinite(0)` is true, so
// a coercion-only test accepts a NULL coordinate as a valid zero — which is exactly the
// bottom-left corner of page 1. Every one of these columns is nullable by design (0087), so
// nulls are the NORMAL state here, not an edge case. Caught by its own test.
const realNumber = (v) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export const hasPlacement = (signer) =>
  !!signer
  && realNumber(signer.place_page) && Number(signer.place_page) >= 1
  && realNumber(signer.place_x)
  && realNumber(signer.place_y)
  && realNumber(signer.place_w) && Number(signer.place_w) > 0;
