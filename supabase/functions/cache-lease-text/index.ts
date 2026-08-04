// Repairs a lease whose searchable text never got cached.
//
// WHY THIS EXISTS. `leases.lease_text` is what the lease assistant, the lease search
// and the AI red-flag review all read. It's normally written once, at import, by
// extract-lease. But before the 2026-07-21 parallel-chunking fix a big SCANNED lease
// could blow the edge function's ~150s wall clock during transcription and come back
// with its FIELDS read fine and its text empty — the 546 "took too long" failure.
// Three of George's leases are in exactly that state (Ricki's 12.3 MB / 36-page scan,
// Victor Rciz, Lease April 13 2022): each has a stored file and a complete
// extraction_raw, and `length(lease_text) = 0`. Re-uploading them would work, but it
// would also re-run the paid analyst + form reads and re-open the review screen for
// terms that are already correct. This does the one missing step and nothing else.
//
// WHAT IT WILL NOT DO — the load-bearing guarantees:
//   • It writes `lease_text` and NOTHING else. No terms, no rent, no dates, no
//     ai_review. It can never move a billed figure.
//   • It refuses to overwrite a transcript that already looks usable, so a re-run is a
//     no-op rather than a paid re-read. Deliberate consequence: a PARTIAL cache (the
//     pre-07-21 Busey shape — pages 16-36 with 1-15 missing) is left alone, because
//     "don't destroy what's there" beats "might improve it". Those carry a visible
//     [Pages X-Y could not be read] marker and are re-uploaded by hand.
//   • It refuses cleanly when there is no document on record, rather than inventing
//     text or writing an empty string that would read as "cached".
//
// COST. A digital PDF or .docx costs $0 — the text layer is read locally, no model call
// at all. Only a real scan pays for transcription (~15–40¢ for a big one).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { uploadFile, deleteFile, MAX_VISION_BYTES, Block } from '../_shared/anthropic.ts';
import { extractPdfText } from '../_shared/pdf.ts';
import { extractDocxText } from '../_shared/docx.ts';
import { transcribeScan } from '../_shared/transcribe.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const MODEL = 'claude-haiku-4-5';
const BUCKET = 'lease-documents';
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Below this, a stored transcript isn't a real lease — it's a stub, a stray header, or
// nothing. Matches the diagnostic query that found the three broken leases. Above it we
// refuse to touch what's there.
const MIN_USABLE_TEXT = 500;

Deno.serve(async (req) => {
  const { preflight, json, serverError } = cors(req);
  if (req.method === 'OPTIONS') return preflight();
  // A scan is uploaded to the Files API once and referenced by id; held here so the
  // finally block can delete it after the read (best-effort).
  let uploadedFileId: string | null = null;
  try {
    // 30/min — see the note in review-lease: ai_rate_check's counter is shared per user
    // across ALL AI functions, so the lowest limit in a sweep is the binding one. This
    // runs alongside review-lease in the "Review leases" sweep and must not be the floor.
    const limited = await enforceRateLimit(req, 30, 60);
    if (limited) return limited;

    const { lease_id } = await req.json();
    if (!lease_id) return json({ error: 'lease_id required' }, 400);

    // The caller's own JWT — so RLS scopes every read and the write to leases the
    // signed-in owner actually owns. This function never uses the service role.
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const { data: lease, error: leaseErr } = await supabase
      .from('leases')
      .select('id, tenant_name, lease_text, lease_file_id')
      .eq('id', lease_id)
      .single();
    if (leaseErr || !lease) return json({ error: 'lease not found' }, 404);

    // Already has a usable copy → do nothing, cost nothing, say so.
    const existing = (lease.lease_text || '').trim();
    if (existing.length >= MIN_USABLE_TEXT) {
      return json({ skipped: 'already_cached', length: existing.length });
    }

    if (!lease.lease_file_id) {
      return json({ error: 'No document is on file for this lease. Upload the lease to make it searchable.' }, 404);
    }

    const { data: fileRow, error: fileErr } = await supabase
      .from('lease_files')
      .select('storage_path, original_filename')
      .eq('id', lease.lease_file_id)
      .single();
    if (fileErr || !fileRow?.storage_path) {
      return json({ error: 'No document is on file for this lease. Upload the lease to make it searchable.' }, 404);
    }

    // A ROW pointing at a file that is no longer in the bucket is the same situation as
    // no row at all, so it gets the same sentence — the landlord's next move is identical
    // either way. Two ways to arrive here: the 2026-07-30 storage cleanup (~40 leases kept
    // their lease_files row), and deleting the lease's file from the document panel, which
    // deliberately leaves lease_file_id alone so the estimate pre-fill keeps working
    // (deleteLeaseFile, api.js). "could not download file" told the landlord nothing.
    const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET).download(fileRow.storage_path);
    if (dlErr || !blob) {
      return json({ error: 'No document is on file for this lease. Upload the lease to make it searchable.' }, 404);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const filename = fileRow.original_filename || fileRow.storage_path;
    const mediaType = mimeFor(filename);

    // Free path first, exactly as extract-lease does: a digital PDF or a Word .docx
    // carries its own text, read locally with no model call. Only a real scan pays.
    let fullText: string | null = null;
    let source: 'text_layer' | 'transcription' = 'text_layer';

    if (mediaType === 'application/pdf') {
      const p = await extractPdfText(bytes);
      if (p) fullText = p.fullText;
    } else if (mediaType === DOCX_TYPE) {
      const d = await extractDocxText(bytes);
      if (d) fullText = d.fullText;
      else return json({ error: 'Could not read the Word document. Save it as a PDF and try again.' }, 422);
    }

    if (!fullText) {
      // Scan / photo / no usable text layer → the vision transcription pipeline.
      if (bytes.length > MAX_VISION_BYTES) {
        return json({ error: 'This scan is too large for AI reading (about 25 MB max). Reduce its resolution or split it into smaller files.' }, 413);
      }
      source = 'transcription';
      uploadedFileId = await uploadFile(bytes, filename, mediaType);
      const docBlock: Block =
        mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'file', file_id: uploadedFileId } }
          : { type: 'image', source: { type: 'file', file_id: uploadedFileId } };
      fullText = await transcribeScan(MODEL, bytes, mediaType, docBlock, filename);
    }

    const text = (fullText || '').trim();
    // An empty read is reported as a failure, never written. Writing '' would leave the
    // lease looking cached while the assistant still had nothing to answer from — the
    // exact silent-blank the 07-21 gap markers exist to prevent.
    if (!text) {
      return json({ error: 'The document could not be read for search. It may be a photo of a photo, or too faint to transcribe.' }, 422);
    }

    const { error: upErr } = await supabase.from('leases').update({ lease_text: text }).eq('id', lease_id);
    if (upErr) return json({ error: upErr.message }, 400);

    return json({ length: text.length, source, tenant_name: lease.tenant_name || null });
  } catch (e) {
    return serverError(e, 'cache-lease-text');
  } finally {
    if (uploadedFileId) await deleteFile(uploadedFileId);
  }
});

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    case 'docx': return DOCX_TYPE;
    default: return 'application/pdf';
  }
}
