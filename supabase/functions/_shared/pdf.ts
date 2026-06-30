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
