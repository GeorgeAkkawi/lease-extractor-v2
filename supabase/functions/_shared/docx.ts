// Reads a Word .docx file's text for free (no model call) so the extractors can
// send cheap text to Claude instead of paying it to transcribe. A .docx is a ZIP
// whose `word/document.xml` holds the body; we pull the `<w:t>` runs out of it.
// Returns null on any failure (not a zip, missing part, parse error) so the caller
// falls back to the proven vision path — quality is never worse than before.
// Mirrors the safety contract of ./pdf.ts (dynamic import inside try/catch).

export interface DocxText {
  fullText: string; // clean transcription for storage / extraction
}

export async function extractDocxText(bytes: Uint8Array): Promise<DocxText | null> {
  try {
    const { ZipReader, Uint8ArrayReader, TextWriter } = await import('jsr:@zip-js/zip-js');
    const reader = new ZipReader(new Uint8ArrayReader(bytes));
    const entries = await reader.getEntries();
    const doc = entries.find((e: { filename: string }) => e.filename === 'word/document.xml');
    if (!doc || !doc.getData) { await reader.close(); return null; }
    const xml: string = await doc.getData(new TextWriter());
    await reader.close();

    const fullText = xmlToText(xml);
    if (!isUsableText(fullText)) return null;
    return { fullText };
  } catch {
    return null; // not a real docx / parse failure → caller uses the vision path
  }
}

// Turn WordprocessingML into plain text: paragraphs (<w:p>) become line breaks,
// tabs/breaks become whitespace, and <w:t> run contents are concatenated.
function xmlToText(xml: string): string {
  const paras = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .split(/<\/w:p>/);
  const lines = paras.map((p) => {
    const runs = [...p.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeEntities(m[1]));
    return runs.join('');
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Same heuristic as pdf.ts: enough real prose to be a genuine document.
function isUsableText(text: string): boolean {
  if (text.length < 200) return false;
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  if (letters < 100) return false;
  return letters / text.length >= 0.35;
}
