// Lazy loader for pdf.js. NOTHING here is imported at module scope by anything on a normal
// page — every caller reaches it through `await import('../lib/pdfRender')`, so the whole
// renderer (~350 kB) stays out of the main bundle and only downloads when someone actually
// opens a document to sign.
//
// This is the exact pattern exceljs already uses (`await import('exceljs/dist/exceljs.min.js')`
// in rentRollExcel.js and its four siblings), which is why exceljs sits in its own 937 kB
// chunk instead of on the critical path. Same discipline, same reason.
//
// ⚠ THE WORKER IS THE PART THAT BREAKS SILENTLY. pdf.js hands parsing to a Web Worker and
// needs a URL for it. `new URL(..., import.meta.url)` is what Vite understands — it emits the
// worker as a real hashed asset and rewrites the URL at build time. A bare string path would
// work in dev and 404 in production, which is the worst shape of bug: invisible until deploy.
//
// The module is cached after the first load, so opening a second document is instant.

let cached = null;

export async function loadPdfjs() {
  if (cached) return cached;
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  cached = pdfjs;
  return pdfjs;
}

// Open a document from a URL (a short-lived signed URL live, a data: URL in the demo).
// Returns the pdf.js document proxy.
export async function openPdf(url) {
  const pdfjs = await loadPdfjs();
  return pdfjs.getDocument({
    url,
    // A signing link is public and the document is fetched cross-origin from Supabase
    // storage; nothing here should ever try to send a cookie or a credential with it.
    withCredentials: false,
    // Fonts and images are all we need; skipping the rest keeps a big scanned lease quick.
    isEvalSupported: false,
  }).promise;
}

// Render one page into a canvas at a width that fits `targetWidth` CSS pixels, and hand back
// everything the placement maths needs.
//
// `pageW`/`pageH` are the UNROTATED page box — deliberately, because that is the space
// pdf-lib will later draw in, and mixing it up with the viewport's rotated box is the single
// most likely way to put a signature in the wrong corner of a scanned lease. See
// src/lib/signPlacement.js.
export async function renderPage(pdf, pageNumber, canvas, targetWidth) {
  const page = await pdf.getPage(pageNumber);
  const rotation = page.rotate || 0;
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.2, (targetWidth || base.width) / base.width);
  const viewport = page.getViewport({ scale });

  // Draw at device resolution so a signature line is legible on a phone, but lay the canvas
  // out at CSS size so the drop coordinates stay in CSS pixels.
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  await page.render({ canvasContext: ctx, viewport }).promise;

  // The unrotated box: a 90/270 viewport reports width and height swapped, so undo that here
  // rather than leaving every caller to remember it.
  const swapped = rotation === 90 || rotation === 270;
  return {
    boxW: viewport.width,
    boxH: viewport.height,
    pageW: swapped ? base.height : base.width,
    pageH: swapped ? base.width : base.height,
    rotation,
  };
}
