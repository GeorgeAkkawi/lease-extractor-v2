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

    const { envelope_id, typed_name, signature_png } = await req.json().catch(() => ({}));
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
      .select('id, role, name, email, typed_name, signed_at, signature_path, consent_at, ip, user_agent')
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

    if (landlordRow) {
      await supabase.from('envelope_signers').update({
        typed_name: name, signed_at: now, consent_at: now, signature_path: sigPath,
        ip: (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null,
        user_agent: (req.headers.get('user-agent') ?? '').slice(0, 500) || null,
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

    const built = await buildExecutedPdf({
      env, tenant, landlordName: name, events: events ?? [],
      srcBytes: isPdf ? srcBytes : null, tenantSig, landlordSig,
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
    await emailCopies(supabase, env, tenant, landlordRow, link?.signedUrl ?? null, isPdf);

    return json({ ok: true, executed_path: executedPath, stamped: isPdf });
  } catch (e) {
    return serverError(e, 'countersign-envelope');
  }
});

// ---------------------------------------------------------------------------
// The executed PDF. A PDF source is loaded and appended to; anything else (a .docx, a
// scan) yields the signature + certificate as a standalone PDF — see the header.
// ---------------------------------------------------------------------------
async function buildExecutedPdf(
  { env, tenant, landlordName, events, srcBytes, tenantSig, landlordSig }: {
    env: Record<string, any>; tenant: Record<string, any>; landlordName: string;
    events: Array<Record<string, any>>; srcBytes: Uint8Array | null;
    tenantSig: Uint8Array | null; landlordSig: Uint8Array;
  },
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import('npm:pdf-lib');

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
  let page = pdf.addPage(A4);
  let y = A4[1] - M;

  const nl = (h: number) => {
    y -= h;
    if (y < M + 24) { page = pdf.addPage(A4); y = A4[1] - M; }
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

  // ---- Signature page ----
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
        if (y - h < M + 24) { page = pdf.addPage(A4); y = A4[1] - M; }
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

  await drawSigner('TENANT', String(tenant.name), String(tenant.typed_name ?? ''), tenant.signed_at, tenantSig, tenant.ip);
  await drawSigner('LANDLORD', landlordName, landlordName, new Date().toISOString(), landlordSig);

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

  return await pdf.save();
}

// Both parties get the finished copy. The tenant email is the one exception to "Amlak never
// emails a tenant without a click" — the click was theirs, and a signer is entitled to a copy
// of what they signed (ESIGN retention).
async function emailCopies(
  supabase: any, env: Record<string, any>, tenant: Record<string, any>,
  landlord: Record<string, any> | undefined, url: string | null, stamped: boolean,
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

  const note = stamped
    ? 'The signed copy, including the certificate of completion, is attached at the link below.'
    : 'The signature page and certificate of completion are at the link below, alongside your original document.';
  const text = `"${env.title}" is now signed by both parties.\n\n${note}\n\n${url}\n\n`
    + `This link is valid for 7 days.\n\n${businessName}`;

  const to = [tenant?.email, landlord?.email].filter(Boolean) as string[];
  for (const addr of to) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: `${businessName} <${FROM_ADDRESS}>`, to: [addr],
          subject: `Signed: ${env.title}`, text,
          ...(landlord?.email ? { reply_to: landlord.email } : {}),
        }),
      });
    } catch (e) {
      console.error('[countersign-envelope] copy email failed:', e instanceof Error ? e.message : String(e));
    }
  }
}
