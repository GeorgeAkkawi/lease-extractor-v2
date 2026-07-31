// Transcribe a SCANNED document to plain text for later search / Q&A.
//
// Lifted verbatim out of extract-lease (2026-07-21 parallel-chunk fix) so a second
// caller — cache-lease-text, which repairs a lease whose transcription failed at
// import — runs the SAME pipeline rather than a second copy of it. Two copies of
// this would drift exactly like the four copies of the estimate math did.
//
// The problem it solves: a scan has no text layer, so the model must visually read
// and RE-TYPE every page, and its binding cost is OUTPUT-generation TIME (~600–700
// tokens/page). A single serial call can only generate ~12–15 pages before the edge
// function's ~150s wall clock kills it — which is why big scans used to cache only
// their first pages, or nothing at all.
//
// The fix: split a multi-page PDF scan into consecutive page-range chunks and
// transcribe them CONCURRENTLY — each chunk is its own small PDF read by its own
// call, so the wall-clock cost is ~ONE chunk (not the sum) and the WHOLE document is
// captured. Because each chunk is physically small, the model transcribes it in full
// and stops on its own (no page-counting to disobey, no mid-document truncation).
// Digital/text PDFs skip all of this — their text layer is read for free, in full.
//
// Honest ceiling: up to MAX_TRANSCRIBE_CHUNKS × CHUNK_PAGES pages are cached per
// upload; a scan beyond that caches its first N pages (with a note). A truly enormous
// scan can't be transcribed verbatim in one 150s call at all — a digital/text PDF
// caches fully for free.
import { transcribeDocument, uploadFile, deleteFile, Block } from './anthropic.ts';
import { splitPdfIntoChunks, type PdfChunk } from './pdf.ts';

const TRANSCRIBE_TIMEOUT_MS = 115_000; // per-transcription box; chunks run in parallel, so this bounds the WALL, not the sum
const TRANSCRIBE_MAX_TOKENS = 12_000;  // single-call fallback: sized so generation reliably STOPS inside the box → non-null
const CHUNK_PAGES = 10;                // pages per chunk (~7k tokens ≈ ~55s) — real headroom inside the budget, so a chunk rarely times out at all
const CHUNK_MAX_TOKENS = 16_000;       // backstop only; a physical sub-PDF stops naturally well under this
const MAX_TRANSCRIBE_CHUNKS = 9;       // still up to 90 pages fully cached per upload (9 × 10)
const CHUNK_BUDGET_MS = 110_000;       // total per chunk ACROSS attempts, so a retry can never push past the edge's ~150s wall
const CHUNK_MIN_RETRY_MS = 20_000;     // don't open a second attempt that couldn't plausibly finish

export function transcribeWithTimeout(model: string, docBlock: Block, ms: number, maxTokens = TRANSCRIBE_MAX_TOKENS): Promise<string | null> {
  return Promise.race([
    transcribeDocument(model, docBlock, { timeoutMs: ms, maxTokens }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// A single image, a small PDF, or a split failure → ONE transcription over the whole
// document. A multi-page PDF scan → parallel page-range chunks, each uploaded +
// transcribed concurrently and stitched back in page order, so the ENTIRE lease is
// captured (not just the first pages).
export async function transcribeScan(
  model: string,
  bytes: Uint8Array,
  mediaType: string,
  fullDocBlock: Block,
  filename: string,
): Promise<string | null> {
  const single = () => transcribeWithTimeout(model, fullDocBlock, TRANSCRIBE_TIMEOUT_MS);
  if (mediaType !== 'application/pdf') return single(); // a single photo/image — nothing to split

  const split = await splitPdfIntoChunks(bytes, CHUNK_PAGES, MAX_TRANSCRIBE_CHUNKS);
  if (!split || split.chunks.length <= 1) return single(); // small / undividable scan → one pass

  const chunkIds: string[] = [];
  try {
    const parts = await Promise.all(split.chunks.map(async (chunk) => ({
      chunk,
      text: await transcribeChunk(model, chunk, filename, chunkIds),
    })));
    parts.sort((a, b) => a.chunk.startPage - b.chunk.startPage);
    if (!parts.some((p) => p.text)) return single(); // every chunk failed → last-ditch single pass over the whole doc

    // A chunk that still failed leaves an EXPLICIT gap marker in its own position — never a
    // silent drop. Filtering failures out (the previous behavior) made a partial transcript
    // read as a complete document: Khaled's 36-page Busey scan lost pages 1-15 to one timed-out
    // chunk and cached as though the lease began mid-clause on page 16 — parties, term and the
    // whole base-rent table gone, with nothing on screen to say so. An honest hole is far
    // better than a plausible-looking lie.
    let combined = parts
      .map((p) => p.text?.trim() ||
        `[Pages ${p.chunk.startPage}-${p.chunk.endPage} could not be read for search. Re-upload this lease to try again.]`)
      .join('\n\n');
    if (split.coveredPages < split.totalPages) {
      combined += `\n\n[Only the first ${split.coveredPages} of ${split.totalPages} pages were transcribed for search. Upload a digital/text PDF of this lease for a full searchable copy.]`;
    }
    return combined;
  } finally {
    await Promise.all(chunkIds.map((id) => deleteFile(id))); // best-effort cleanup, in parallel
  }
}

// One chunk, with a bounded second attempt. A chunk that fails FAST (a transient 429/5xx, or an
// upload hiccup) leaves nearly the whole budget for a retry — that's the case worth rescuing, and
// it's the cheap one. A chunk that fails by TIMEOUT has already spent its budget, so it gives up
// rather than pushing the function past the edge's wall clock. Either way the caller marks the gap.
async function transcribeChunk(model: string, chunk: PdfChunk, filename: string, chunkIds: string[]): Promise<string | null> {
  const deadline = Date.now() + CHUNK_BUDGET_MS;
  let fid: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < CHUNK_MIN_RETRY_MS) break;
    try {
      if (!fid) {
        fid = await uploadFile(chunk.bytes, `${filename}-p${chunk.startPage}-${chunk.endPage}`, 'application/pdf');
        chunkIds.push(fid); // registered immediately so the finally-block cleanup can't leak it
      }
      const block: Block = { type: 'document', source: { type: 'file', file_id: fid } };
      const text = await transcribeWithTimeout(model, block, remaining, CHUNK_MAX_TOKENS);
      if (text && text.trim()) return text;
    } catch {
      // fall through to the retry, else to the caller's gap marker
    }
  }
  return null;
}
