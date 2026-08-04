// The landlord's signature, and the moment the document becomes executed. Runs after the
// tenant has signed (sign-envelope) and produces the artifact the whole feature exists for:
// the original document, a signature page carrying both signatures, and a Certificate of
// Completion printed from the audit trail.
//
// AUTH: verify_jwt defaults true (config.toml, no override), but we ALSO do an explicit
// auth.getUser() check — enforceRateLimit fails OPEN, so it is a cost guard, not the gate.
// Every read and write below runs under the CALLER'S OWN JWT, so RLS is what guarantees a
// landlord can only countersign his own envelope. There is no service-role client here, on
// purpose: this function has no unauthenticated caller and therefore needs no bypass.
//
// ── WHY THE CERTIFICATE IS THE POINT ────────────────────────────────────────────────────
// ESIGN/UETA make an electronic signature enforceable on four things: intent, consent,
// attribution and retention. Attribution — UETA §9, "may be proved in any manner, including
// a showing of the efficacy of any security procedure" — is the one that needs evidence, and
// this page IS that evidence: every event with its timestamp, IP and user agent, plus the
// SHA-256 of the exact bytes that were signed. Without it the signature is an assertion.
//
// ── WHAT IT CANNOT DO, STATED PLAINLY ───────────────────────────────────────────────────
// A .docx cannot be stamped — there is no page geometry to draw on without a full Word
// renderer. So a Word source yields the certificate as its own PDF alongside the original,
// and the UI says exactly that rather than implying a stamp that isn't there. A PDF source
// gets both merged into one file, which is what a landlord actually wants to file.
//
// ⚠ AN EXECUTED ENVELOPE APPLIES NOTHING. It does not touch the lease's term, rent, square
// footage or estimates, and it does not create a lease_addendums row — an addendum in that
// table means "an amendment that HAS been applied" (its own column reads "What it changed"),
// and filing an unapplied one would make that table lie. Pushing a signed document into the
// lease is a separate, explicitly confirmed action.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_ADDRESS = Deno.env.get('TENANT_FROM_EMAIL') ?? 'letters@amlakre.com';
const MAX_SIGNATURE_BYTES = 200 * 1024;

// pdf-lib's standard fonts are WinAnsi — a curly quote or an em dash throws on draw. Every
// string that reaches the page goes through here first. (The app's own prose is full of
// them, so this is not hypothetical.)
const safe = (s: unknown) =>
  String(s ?? '')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[…]/g, '...')
    .replace(/[ ]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, '');

const stamp = (iso: string | null | undefined) => {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
};

// ⚠ JS ↔ TS MIRROR PAIR — CLAUDE.md §3. The three helpers below are the Deno twins of
// `hasPlacement` and `toUnrotated` in src/lib/signPlacement.js, and of `placementColumns` in
// sign-envelope/index.ts. **Change them in the same commit or a signature silently lands in
// the wrong place**, which is the kind of drift nobody notices until a lease is printed.
// The JS side carries the full explanation and is unit-tested at four page rotations.

const realNum = (v: unknown) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// Complete placement, or nothing. Half a placement would stamp at the corner of page 1.
// NOTE `Number(null)` is 0 and finite — the null check is doing real work here.
const placed = (p: Record<string, unknown> | null | undefined) =>
  !!p && realNum(p.place_page) && Number(p.place_page) >= 1
  && realNum(p.place_x) && realNum(p.place_y)
  && realNum(p.place_w) && Number(p.place_w) > 0;

// The landlord's own placement arrives from the app rather than from a signer row; validated
// the same way sign-envelope validates the tenant's, so neither client can write nonsense.
const NO_PLACE = { place_page: null, place_x: null, place_y: null, place_w: null };
function placementColumns(p: unknown): Record<string, number | null> {
  if (!p || typeof p !== 'object') return NO_PLACE;
  const { page, x, y, w } = p as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pg = n(page); const px = n(x); const py = n(y); const pw = n(w);
  if (pg === null || px === null || py === null || pw === null) return NO_PLACE;
  if (pg < 1 || pg > 5000) return NO_PLACE;
  if (px < 0 || py < 0 || px > 20000 || py > 20000) return NO_PLACE;
  if (pw <= 0 || pw > 2000) return NO_PLACE;
  return { place_page: Math.trunc(pg), place_x: px, place_y: py, place_w: pw };
}

// Viewport space (pdf.js — /Rotate already applied) → the page's UNROTATED space, which is
// the only space pdf-lib draws in. Identity at 0°, which is why skipping this looks fine on
// every test PDF and is wrong on a sideways scan. Mirrors toUnrotated() in signPlacement.js.
function unrotate(
  { x, y, w, h }: { x: number; y: number; w: number; h: number },
  rotation: number, pageW: number, pageH: number,
) {
  const r = ((Math.trunc(rotation) % 360) + 360) % 360;
  if (r === 0) return { x, y, angle: 0 };
  if (r === 180) return { x: pageW - x - w, y: pageH - y - h, angle: 180 };
  if (r === 90) return { x: x + h, y, angle: 90 };
  return { x: pageW - y - h, y: pageH - x - w, angle: 270 };
}

Deno.serve(async (req) => {
  const { preflight, json, serverError } = cors(req);
  if (req.method === 'OPTIONS') return preflight();

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Please sign in and try again.' }, 401);
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData } = await supabase.auth.getUser();
    const user = userData?.user;
    if (!user) return json({ error: 'Please sign in and try again.' }, 401);

    const limited = await enforceRateLimit(req, 10, 60);
    if (limited) return limited;

    const { envelope_id, typed_name, signature_png, placement } = await req.json().catch(() => ({}));
    if (!envelope_id) return json({ error: 'Which document?' }, 400);

    const name = String(typed_name ?? '').trim().slice(0, 200);
    if (!name) return json({ error: 'Type your name to sign.' }, 400);

    const prefix = 'data:image/png;base64,';
    const dataUrl = String(signature_png ?? '');
    if (!dataUrl.startsWith(prefix)) return json({ error: 'Draw or type your signature first.' }, 400);
    let landlordSig: Uint8Array;
    try {
      const bin = atob(dataUrl.slice(prefix.length));
      if (bin.length > MAX_SIGNATURE_BYTES) return json({ error: 'That signature image is too large.' }, 400);
      landlordSig = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return json({ error: 'That signature couldn’t be read.' }, 400);
    }

    // RLS scopes this to the caller's own envelopes — that IS the authorization check.
    const { data: env } = await supabase
      .from('signature_envelopes')
      .select('id, lease_id, property_id, title, filename, storage_path, doc_sha256, status, sent_at, signed_at')
      .eq('id', envelope_id)
      .maybeSingle();
    if (!env) return json({ error: 'That document no longer exists.' }, 404);
    if (env.status !== 'signed') {
      return json({ error: env.status === 'executed'
        ? 'That document is already complete.'
        : 'The tenant hasn’t signed this yet.' }, 409);
    }

    const { data: signers } = await supabase
      .from('envelope_signers')
      .select('id, role, name, email, typed_name, signed_at, signature_path, consent_at, ip, user_agent, place_page, place_x, place_y, place_w')
      .eq('envelope_id', env.id);
    const tenant = (signers ?? []).find((s) => s.role === 'tenant');
    const landlordRow = (signers ?? []).find((s) => s.role === 'landlord');
    if (!tenant?.signed_at) return json({ error: 'The tenant hasn’t signed this yet.' }, 409);

    const now = new Date().toISOString();

    // ---- Store the landlord's signature ------------------------------------
    const sigPath = `signatures/${env.id}/landlord-${crypto.randomUUID()}.png`;
    const upSig = await supabase.storage.from('lease-documents')
      .upload(sigPath, landlordSig, { contentType: 'image/png', upsert: false });
    if (upSig.error) throw upSig.error;

    const landlordPlace = placementColumns(placement);
    if (landlordRow) {
      await supabase.from('envelope_signers').update({
        typed_name: name, signed_at: now, consent_at: now, signature_path: sigPath,
        ip: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null,
        user_agent: (req.headers.get('user-agent') ?? '').slice(0, 500) || null,
        ...landlordPlace,
      }).eq('id', landlordRow.id);
    }
    await supabase.from('envelope_events').insert({
      owner_id: user.id, envelope_id: env.id, kind: 'countersigned', actor: 'landlord',
      ip: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null,
      user_agent: (req.headers.get('user-agent') ?? '').slice(0, 500) || null,
      detail: { typed_name: name },
    });

    // ---- Gather everything the certificate prints --------------------------
    const { data: events } = await supabase
      .from('envelope_events').select('kind, actor, at, ip, user_agent, detail')
      .eq('envelope_id', env.id).order('at', { ascending: true });

    const srcDl = await supabase.storage.from('lease-documents').download(String(env.storage_path));
    const srcBytes = srcDl.data ? new Uint8Array(await srcDl.data.arrayBuffer()) : null;

    const tenantSigDl = tenant.signature_path
      ? await supabase.storage.from('lease-documents').download(String(tenant.signature_path))
      : null;
    const tenantSig = tenantSigDl?.data ? new Uint8Array(await tenantSigDl.data.arrayBuffer()) : null;

    const isPdf = (env.filename ?? '').toLowerCase().endsWith('.pdf')
      || (!!srcBytes && srcBytes.length > 4 && srcBytes[0] === 0x25 && srcBytes[1] === 0x50);

    const { bytes: built, tenantStamped: tenantOnDoc, landlordStamped: landlordOnDoc } =
      await buildExecutedPdf({
        env, tenant, landlordName: name, events: events ?? [],
        srcBytes: isPdf ? srcBytes : null, tenantSig, landlordSig,
        landlordPlace,
      });

    // ---- Store the result ---------------------------------------------------
    const base = `executed/${env.id}`;
    const execName = `${(env.title || 'document').replace(/[^\w .-]/g, '_').slice(0, 80)} (signed).pdf`;
    const upExec = await supabase.storage.from('lease-documents')
      .upload(`${base}/${crypto.randomUUID()}.pdf`, built, {
        contentType: 'application/pdf', upsert: false,
      });
    if (upExec.error) throw upExec.error;
    const executedPath = upExec.data.path;

    await supabase.from('documents').insert({
      owner_id: user.id, entity_type: 'envelope', entity_id: env.id,
      storage_path: executedPath, filename: execName,
      bytes: built.byteLength, mime: 'application/pdf',
      label: isPdf ? 'Executed copy' : 'Signature certificate',
    });

    await supabase.from('signature_envelopes').update({
      status: 'executed', countersigned_at: now, executed_at: now,
      executed_path: executedPath,
      // On a PDF source the certificate is bound into the executed file; on a Word source
      // it is the file. Either way this points at where the certificate can be read.
      certificate_path: executedPath,
    }).eq('id', env.id);

    await supabase.from('envelope_events').insert({
      owner_id: user.id, envelope_id: env.id, kind: 'executed', actor: 'system',
      detail: { stamped: isPdf, bytes: built.byteLength },
    });

    // ---- Send both parties their copy --------------------------------------
    const { data: link } = await supabase.storage
      .from('lease-documents').createSignedUrl(executedPath, 60 * 60 * 24 * 7);
    await emailCopies(supabase, env, tenant, landlordRow, link?.signedUrl ?? null, isPdf, built, execName);

    return json({
      ok: true, executed_path: executedPath, stamped: isPdf,
      // Which signatures landed ON the document rather than on an appended page — the UI
      // tells the landlord, because "signed" and "signed in the right place" are different
      // facts and he is the one who will hand this to a lender.
      on_document: { tenant: tenantOnDoc, landlord: landlordOnDoc },
    });
  } catch (e) {
    return serverError(e, 'countersign-envelope');
  }
});

// ---------------------------------------------------------------------------
// The executed PDF. A PDF source is loaded and appended to; anything else (a .docx, a
// scan) yields the signature + certificate as a standalone PDF — see the header.
// ---------------------------------------------------------------------------
async function buildExecutedPdf(
  { env, tenant, landlordName, events, srcBytes, tenantSig, landlordSig, landlordPlace }: {
    env: Record<string, any>; tenant: Record<string, any>; landlordName: string;
    events: Array<Record<string, any>>; srcBytes: Uint8Array | null;
    tenantSig: Uint8Array | null; landlordSig: Uint8Array;
    landlordPlace: Record<string, number | null>;
  },
): Promise<{ bytes: Uint8Array; tenantStamped: boolean; landlordStamped: boolean }> {
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('npm:pdf-lib');

  let pdf: any;
  if (srcBytes) {
    try {
      pdf = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    } catch {
      pdf = await PDFDocument.create(); // unreadable PDF → certificate stands alone
    }
  } else {
    pdf = await PDFDocument.create();
  }

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const A4: [number, number] = [595, 842];
  const M = 56;
  // ⚠ NO PAGE IS ADDED UP FRONT. When both signatures land on the document itself the
  // SIGNATURES page is skipped entirely, and an eagerly-created page would leave a blank
  // sheet in the middle of the landlord's executed lease. `newPage()` is called only where
  // something is actually about to be written.
  let page: any = null;
  let y = 0;
  const newPage = () => { page = pdf.addPage(A4); y = A4[1] - M; };

  const nl = (h: number) => {
    y -= h;
    if (y < M + 24) newPage();
  };
  const write = (text: string, { size = 10, f = font, gap = 15, colour = rgb(0.15, 0.15, 0.15) } = {}) => {
    const t = safe(text);
    const max = A4[0] - M * 2;
    const words = t.split(/\s+/);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) > max && line) {
        page.drawText(line, { x: M, y, size, font: f, color: colour });
        nl(gap); line = w;
      } else line = next;
    }
    if (line) { page.drawText(line, { x: M, y, size, font: f, color: colour }); nl(gap); }
  };
  const rule = () => {
    page.drawLine({
      start: { x: M, y: y + 6 }, end: { x: A4[0] - M, y: y + 6 },
      thickness: 0.5, color: rgb(0.75, 0.75, 0.75),
    });
    nl(14);
  };

  // ══ STAMP ON THE ACTUAL SIGNATURE LINE ═══════════════════════════════════════════════
  // George, 2026-08-04: *"they arent signing the actual document just a box that says that…
  // can the software copy the signature and place it where its supposed to go on the lease?"*
  // Each signer dropped their own mark on the page (0087); this puts it there for real.
  //
  // ⚠ pdf.js AND pdf-lib DISAGREE ABOUT ROTATION. The stored point came through a pdf.js
  // viewport, which has ALREADY applied the page's /Rotate; pdf-lib draws in the page's
  // UNROTATED space and ignores /Rotate entirely. `unrotate()` is the bridge. On a page with
  // no rotation it is the identity — which is why this looks fine on every test PDF and is
  // wrong on a sideways scan if you skip it.
  const pages = pdf.getPages();
  const stampOne = async (place: Record<string, any>, png: Uint8Array | null, caption: string) => {
    if (!png || !placed(place)) return false;
    const idx = Math.trunc(Number(place.place_page)) - 1;
    const target = pages[idx];
    if (!target) return false; // a page number past the end of THIS document — fall back
    try {
      const img = await pdf.embedPng(png);
      const w = Number(place.place_w);
      const h = (img.height / img.width) * w;
      const { width: pw, height: ph } = target.getSize();
      const angle = target.getRotation().angle || 0;
      const p = unrotate({ x: Number(place.place_x), y: Number(place.place_y), w, h }, angle, pw, ph);
      target.drawImage(img, { x: p.x, y: p.y, width: w, height: h, rotate: degrees(p.angle) });
      // A small caption under the mark, so the page itself says who signed and when rather
      // than making a reader flip to the certificate to find out.
      if (p.angle === 0) {
        target.drawText(safe(caption), {
          x: p.x, y: Math.max(2, p.y - 8), size: 6, font, color: rgb(0.35, 0.35, 0.35),
        });
      }
      return true;
    } catch {
      return false; // an unreadable image must never lose the whole executed document
    }
  };

  const tenantStamped = await stampOne(
    tenant, tenantSig,
    `Signed by ${tenant.typed_name || tenant.name} - ${stamp(tenant.signed_at)}`,
  );
  const landlordStamped = await stampOne(
    landlordPlace, landlordSig,
    `Signed by ${landlordName} - ${stamp(new Date().toISOString())}`,
  );

  // ---- Signature page ----
  // ⚠ ONLY WHEN THE MARKS COULDN'T GO ON THE DOCUMENT ITSELF. When both were stamped in
  // place this page is pure noise — the signatures are where a reader expects them. When
  // either was not (a .docx, a scan pdf.js refused, a signer who never dragged anything),
  // this is the whole reason the signature is associated with the record at all, so it stays.
  // The CERTIFICATE below is appended unconditionally either way.
  if (!(tenantStamped && landlordStamped)) {
  write('SIGNATURES', { size: 16, f: bold, gap: 26 });
  write(String(env.title), { size: 11, f: bold, gap: 20 });
  rule();

  const drawSigner = async (label: string, who: string, typed: string, at: string, png: Uint8Array | null, ip?: string) => {
    write(label, { size: 8.5, f: bold, gap: 14, colour: rgb(0.45, 0.45, 0.45) });
    if (png) {
      try {
        const img = await pdf.embedPng(png);
        const w = Math.min(200, img.width);
        const h = (img.height / img.width) * w;
        if (y - h < M + 24) newPage();
        page.drawImage(img, { x: M, y: y - h + 8, width: w, height: h });
        nl(h + 6);
      } catch { /* an unreadable signature image must not lose the whole certificate */ }
    }
    page.drawLine({
      start: { x: M, y: y + 4 }, end: { x: M + 220, y: y + 4 },
      thickness: 0.5, color: rgb(0.4, 0.4, 0.4),
    });
    nl(14);
    write(who, { size: 10.5, f: bold, gap: 13 });
    if (typed && typed !== who) write(`Typed: ${typed}`, { size: 9, gap: 12, colour: rgb(0.4, 0.4, 0.4) });
    write(`Signed ${stamp(at)}${ip ? ` from ${ip}` : ''}`, { size: 9, gap: 22, colour: rgb(0.4, 0.4, 0.4) });
  };

  // Only the signer whose mark did NOT land on the document needs a block here.
  if (!tenantStamped) {
    await drawSigner('TENANT', String(tenant.name), String(tenant.typed_name ?? ''), tenant.signed_at, tenantSig, tenant.ip);
  }
  if (!landlordStamped) {
    await drawSigner('LANDLORD', landlordName, landlordName, new Date().toISOString(), landlordSig);
  }
  }

  // ---- Certificate of Completion ----
  page = pdf.addPage(A4); y = A4[1] - M;
  write('CERTIFICATE OF COMPLETION', { size: 16, f: bold, gap: 24 });
  write(
    'This certificate records the electronic signing of the document above. It is generated by Amlak '
    + 'and is intended as evidence of the signing process under the U.S. ESIGN Act and UETA.',
    { size: 9, gap: 13, colour: rgb(0.4, 0.4, 0.4) },
  );
  nl(8); rule();

  write('DOCUMENT', { size: 8.5, f: bold, gap: 14, colour: rgb(0.45, 0.45, 0.45) });
  write(`Title: ${env.title}`, { size: 9.5, gap: 13 });
  if (env.filename) write(`File: ${env.filename}`, { size: 9.5, gap: 13 });
  write(`Envelope ID: ${env.id}`, { size: 9.5, gap: 13 });
  // The tamper seal. If these bytes ever change, this line stops matching.
  write(`Document SHA-256: ${env.doc_sha256}`, { size: 8, gap: 13 });
  write(`Sent: ${stamp(env.sent_at)}`, { size: 9.5, gap: 20 });

  write('SIGNERS', { size: 8.5, f: bold, gap: 14, colour: rgb(0.45, 0.45, 0.45) });
  write(`${tenant.name}${tenant.email ? ` <${tenant.email}>` : ''} - tenant`, { size: 9.5, gap: 12 });
  write(`   Consented ${stamp(tenant.consent_at)} | Signed ${stamp(tenant.signed_at)}`, { size: 8.5, gap: 12, colour: rgb(0.4, 0.4, 0.4) });
  if (tenant.ip) write(`   IP ${tenant.ip}`, { size: 8.5, gap: 12, colour: rgb(0.4, 0.4, 0.4) });
  if (tenant.user_agent) write(`   ${tenant.user_agent}`, { size: 7.5, gap: 12, colour: rgb(0.5, 0.5, 0.5) });
  write(`${landlordName} - landlord (signed in Amlak under an authenticated session)`, { size: 9.5, gap: 20 });

  write('AUDIT TRAIL', { size: 8.5, f: bold, gap: 14, colour: rgb(0.45, 0.45, 0.45) });
  for (const e of events) {
    write(`${stamp(e.at)}  ${String(e.kind).toUpperCase()}  (${e.actor})${e.ip ? `  IP ${e.ip}` : ''}`,
      { size: 8.5, gap: 12 });
  }

  nl(10);
  write(
    'Attribution note: the signing link was a 256-bit random token delivered to the signer email above and stored '
    + 'only as a SHA-256 digest. It was never reusable after completion and expired on its own schedule.',
    { size: 7.5, gap: 11, colour: rgb(0.5, 0.5, 0.5) },
  );

  return { bytes: await pdf.save(), tenantStamped, landlordStamped };
}

// Both parties get the finished copy. The tenant email is the one exception to "Amlak never
// emails a tenant without a click" — the click was theirs, and a signer is entitled to a copy
// of what they signed (ESIGN retention).
// ⚠ THE COPY IS ATTACHED, NOT JUST LINKED. ESIGN's retention limb is about the signer being
// able to KEEP a copy of what they signed; the 7-day signed URL this used to send alone left
// a tenant with nothing after a week. The link stays as the fallback for a file too large to
// attach (Resend caps a message around 40 MB, and a scanned 80-page lease can get there).
const MAX_ATTACH_BYTES = 18 * 1024 * 1024;

// Base64 in 32 kB slices. `String.fromCharCode(...bytes)` on a multi-megabyte array blows the
// argument limit and throws — which would have failed only on real leases, never in testing.
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function emailCopies(
  supabase: any, env: Record<string, any>, tenant: Record<string, any>,
  landlord: Record<string, any> | undefined, url: string | null, stamped: boolean,
  pdfBytes?: Uint8Array, filename?: string,
) {
  if (!RESEND_API_KEY || !url) return;
  let businessName = 'Amlak';
  try {
    const { data: prop } = await supabase.from('properties')
      .select('corporation_id').eq('id', env.property_id).maybeSingle();
    if (prop?.corporation_id) {
      const { data: corp } = await supabase.from('corporations')
        .select('name').eq('id', prop.corporation_id).maybeSingle();
      if (corp?.name) businessName = String(corp.name).replace(/[\r\n"<>]/g, ' ').slice(0, 60);
    }
  } catch { /* a display name is not worth failing an executed document over */ }

  const attachable = !!pdfBytes && pdfBytes.byteLength <= MAX_ATTACH_BYTES;
  const attachments = attachable
    ? [{ filename: filename || 'signed.pdf', content: toBase64(pdfBytes!) }]
    : undefined;

  const note = stamped
    ? 'The signed copy, with both signatures and the certificate of completion, is attached.'
    : 'The signature page and certificate of completion are attached, alongside your original document.';
  const text = `"${env.title}" is now signed by both parties.\n\n`
    + (attachable
      ? `${note}\n\nYou can also download it here for the next 7 days:\n${url}\n\n`
      : `The signed copy is too large to attach. Download it here — the link is valid for 7 days:\n${url}\n\n`)
    + `Please keep a copy for your records.\n\n${businessName}`;

  const to = [tenant?.email, landlord?.email].filter(Boolean) as string[];
  for (const addr of to) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${businessName} <${FROM_ADDRESS}>`, to: [addr],
          subject: `Signed: ${env.title}`, text,
          ...(attachments ? { attachments } : {}),
          ...(landlord?.email ? { reply_to: landlord.email } : {}),
        }),
      });
      if (!res.ok) {
        console.error('[countersign-envelope] Resend rejected copy:', res.status, await res.text().catch(() => ''));
      }
    } catch (e) {
      console.error('[countersign-envelope] copy email failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
