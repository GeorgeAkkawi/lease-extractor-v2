// Reads a PDF's embedded text layer for free (no model call) so extractors can
// send cheap text to Claude instead of paying it to also transcribe the document.
// Returns null when the PDF has no usable text layer — a scan/photo/handwritten
// doc, a parse failure, or a garbled layer — so the caller falls back to the
// vision path. Every failure degrades to null: the AI vision flow stays the
// safety net and quality is never worse than before.

export interface PdfText {
  pages: string[]; // text of each page, in order
  combined: string; // pages joined with explicit [PAGE n] markers (for page-aware fields)
  fullText: string; // clean transcription (no markers) for storage / later Q&A
}

export async function extractPdfText(bytes: Uint8Array): Promise<PdfText | null> {
  try {
    // Dynamic import + try/catch so a resolver/runtime hiccup can never crash the
    // function — it just falls through to the proven vision path.
    const { extractText, getDocumentProxy } = await import('npm:unpdf');
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: false });

    const pages = (Array.isArray(text) ? text : [text]).map((p: string) => (p ?? '').trim());
    const fullText = pages.join('\n\n').trim();
    if (!isUsableText(fullText)) return null;

    const combined = pages
      .map((p, i) => `[PAGE ${i + 1}]\n${p}`)
      .join('\n\n')
      .trim();

    return { pages, combined, fullText };
  } catch {
    return null; // no text layer / parse failure → caller uses the vision path
  }
}

// Heuristic guard against PDFs whose "text layer" is empty or garbage (scanned
// images, broken font encodings). For those, Claude's vision reads the real
// document more reliably than the scrambled text would. Conservative on purpose:
// a false negative just costs a vision call; a false positive could feed the model
// junk, so we err toward falling back.
function isUsableText(text: string): boolean {
  if (text.length < 200) return false; // too little to be a real lease/contract
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 100) return false; // needs real words, not just symbols/whitespace
  return letters / text.length >= 0.35; // mostly prose, not mojibake
}

// Split a PDF into consecutive page-range chunks (each its own small PDF) so a big
// SCANNED lease can be transcribed in PARALLEL — each chunk is transcribed by its own
// concurrent model call, so the wall-clock cost is ~ONE chunk instead of the whole
// document (which can't be transcribed verbatim inside one edge call's ~150s budget).
// Because each chunk is a physically small PDF, the model transcribes it in full and
// stops on its own — no page-counting to get wrong, no mid-document truncation. Returns
// null on ANY failure (encrypted / malformed / out-of-memory) so the caller safely falls
// back to a single whole-document transcription (never worse than before).
export interface PdfChunk { bytes: Uint8Array; startPage: number; endPage: number; }
export interface PdfSplit { chunks: PdfChunk[]; totalPages: number; coveredPages: number; }

export async function splitPdfIntoChunks(
  bytes: Uint8Array,
  pagesPerChunk: number,
  maxChunks: number,
): Promise<PdfSplit | null> {
  try {
    const { PDFDocument } = await import('npm:pdf-lib');
    // ignoreEncryption lets us split an owner-locked (but readable) scan.
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const totalPages = src.getPageCount();
    if (totalPages <= 0) return null;

    const chunks: PdfChunk[] = [];
    let coveredPages = 0;
    for (let start = 0; start < totalPages && chunks.length < maxChunks; start += pagesPerChunk) {
      const end = Math.min(start + pagesPerChunk, totalPages);
      const indices: number[] = [];
      for (let i = start; i < end; i++) indices.push(i);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, indices); // carries each page's image data
      for (const p of copied) out.addPage(p);
      // useObjectStreams:false skips metadata re-compression — cheaper CPU on the edge,
      // and negligible size gain here since a scan's bulk is already-compressed images.
      const outBytes = await out.save({ useObjectStreams: false });
      chunks.push({ bytes: outBytes, startPage: start + 1, endPage: end });
      coveredPages = end;
    }
    return { chunks, totalPages, coveredPages };
  } catch {
    return null; // caller uses single-call transcription
  }
}
