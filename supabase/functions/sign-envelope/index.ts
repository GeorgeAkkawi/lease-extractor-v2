// THE ONLY UNAUTHENTICATED USER ENDPOINT IN THIS PROJECT. A tenant signing a lease has no
// account and never will, so this function is deployed with verify_jwt = false and reads with
// the SERVICE ROLE, bypassing RLS. Everything here is shaped around making that safe. Read
// this header before changing a single query below.
//
// ── THE GATE IS THE TOKEN, AND ONLY THE TOKEN ───────────────────────────────────────────
// 32 bytes of CSPRNG (send-for-signature), delivered once by email, stored ONLY as
// sha256(token) in envelope_signers.token_hash — which is UNIQUE, so the lookup is one exact
// index hit. Consequences, all deliberate:
//   • A leaked database yields no working links. There is no `token` column to steal.
//   • The token is the ONLY selector this function accepts. It takes no envelope id, no
//     lease id, no signer id — nothing enumerable — which is why nothing can be walked.
//   • 2^256 makes guessing infeasible. The throttle below is noise control, NOT the gate,
//     and must never be mistaken for one.
// ⚠ enforceRateLimit (_shared/ratelimit.ts) CANNOT be used here — it returns 401 when there
// is no Authorization header, which is every request this function will ever see.
//
// ── WHAT IT IS ALLOWED TO SEE ───────────────────────────────────────────────────────────
// Explicit column lists everywhere, never select('*'). The response carries the document, the
// signer's own name, the business name, the property name, the title and the expiry — and
// nothing else. No rent, no square footage, no lease id, no other tenant, no owner identity
// beyond the business name the tenant already knows. signature_envelopes holds no financial
// column at all (0085), so there is none in the row to leak by accident.
//
// ── THE DOCUMENT ────────────────────────────────────────────────────────────────────────
// The bucket is private. The raw storage path never leaves this function; the tenant gets a
// 120-second signed URL, minted per view.
//
// ── EXPIRY IS ENFORCED HERE, NOT BY A SWEEP ─────────────────────────────────────────────
// An envelope past expires_at still holds status 'sent' in the database — nothing rewrites
// it. `liveState()` below is what actually refuses the document, and src/lib/envelopes.js
// mirrors the identical rule for the landlord's screens. The two must move together.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_ADDRESS = Deno.env.get('TENANT_FROM_EMAIL') ?? 'letters@amlakre.com';
const MAX_SIGNATURE_BYTES = 200 * 1024; // a drawn signature is ~10–30KB; 200KB is generous
const SIGNED_URL_SECONDS = 120;

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (s: string) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

const clientIp = (req: Request) =>
  (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null;

const userAgent = (req: Request) => (req.headers.get('user-agent') ?? '').slice(0, 500) || null;

// Best-effort per-isolate flood control. Resets on a cold start and is not shared between
// isolates — which is fine, because it is protecting against a naive request flood, not
// against guessing. See the header: the token is the gate.
const HITS = new Map<string, number[]>();
function flooded(ip: string | null, limit = 60, windowMs = 60_000): boolean {
  if (!ip) return false;
  const now = Date.now();
  const recent = (HITS.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 5000) HITS.clear(); // never let the map grow unbounded
  return recent.length > limit;
}

// Where the signer dropped their mark, in PDF points (0087). Validated rather than trusted:
// this arrives from an unauthenticated browser, so a hostile or broken client must not be
// able to write nonsense into the row that the stamper later reads.
//
// ⚠ ALL-OR-NOTHING, AND NULL IS A PERFECTLY GOOD ANSWER. Anything incomplete or out of range
// stores four nulls, and the executed PDF falls back to an appended signature page. Half a
// placement would stamp a signature at the corner of page 1 of somebody's lease, which is far
// worse than not stamping at all. `hasPlacement()` in src/lib/signPlacement.js applies the
// same rule on the read side — the two are a mirror pair.
const NONE = { place_page: null, place_x: null, place_y: null, place_w: null };
function placementColumns(p: unknown): Record<string, number | null> {
  if (!p || typeof p !== 'object') return NONE;
  const { page, x, y, w } = p as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const pg = n(page); const px = n(x); const py = n(y); const pw = n(w);
  if (pg === null || px === null || py === null || pw === null) return NONE;
  // A page past the end, a negative point, or a signature wider than any real page is a
  // broken client, not a placement. 2000pt is comfortably larger than A0.
  if (pg < 1 || pg > 5000) return NONE;
  if (px < 0 || py < 0 || px > 20000 || py > 20000) return NONE;
  if (pw <= 0 || pw > 2000) return NONE;
  return { place_page: Math.trunc(pg), place_x: px, place_y: py, place_w: pw };
}

// The one place "is this link still usable" is decided. Mirrored by envelopeStatus() in
// src/lib/envelopes.js.
function liveState(env: { status: string; expires_at: string }): string {
  if (env.status !== 'sent') return env.status;
  return new Date(env.expires_at).getTime() <= Date.now() ? 'expired' : 'sent';
}

// Why the tenant can't proceed, in their words — never in ours. "Voided" would mean nothing
// to someone who only ever saw a link.
const CLOSED_MESSAGE: Record<string, string> = {
  signed: 'You’ve already signed this document. You’ll receive the completed copy by email once it’s countersigned.',
  executed: 'This document has already been completed and signed by both parties.',
  declined: 'This document was declined and can no longer be signed.',
  voided: 'This request was cancelled by the sender. Please contact them if you were expecting to sign something.',
  expired: 'This signing link has expired. Please contact the sender for a new one.',
};

Deno.serve(async (req) => {
  const { preflight, json, serverError } = cors(req);
  if (req.method === 'OPTIONS') return preflight();

  try {
    const ip = clientIp(req);
    if (flooded(ip)) return json({ error: 'Too many requests. Please wait a moment.' }, 429);

    const { action, token, consent, typed_name, signature_png, reason, placement } =
      await req.json().catch(() => ({}));

    if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) {
      return json({ error: 'This signing link isn’t valid.' }, 404);
    }
    if (!['view', 'sign', 'decline'].includes(String(action))) {
      return json({ error: 'Unknown action.' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    // ---- THE ONLY LOOKUP: token hash → one signer row ----------------------
    const token_hash = await sha256Hex(token);
    const { data: signer } = await admin
      .from('envelope_signers')
      .select('id, envelope_id, owner_id, name, email, signed_at, consent_at')
      .eq('token_hash', token_hash)
      .eq('role', 'tenant')
      .maybeSingle();

    // Same 404 for "no such token" and "malformed token" — nothing here distinguishes a
    // near-miss from a wild guess.
    if (!signer) return json({ error: 'This signing link isn’t valid.' }, 404);

    const { data: env } = await admin
      .from('signature_envelopes')
      .select('id, owner_id, property_id, title, filename, storage_path, message, status, expires_at')
      .eq('id', signer.envelope_id)
      .maybeSingle();
    if (!env) return json({ error: 'This signing link isn’t valid.' }, 404);

    const state = liveState(env as { status: string; expires_at: string });
    if (state !== 'sent') {
      return json({ closed: true, state, error: CLOSED_MESSAGE[state] ?? 'This document is no longer available to sign.' }, 410);
    }

    // Who is asking, in a form the tenant will recognise. Two narrow reads: the property's
    // name (not its full record) and its corporation's name (not its contact details).
    const { data: prop } = await admin
      .from('properties').select('name, corporation_id').eq('id', env.property_id).maybeSingle();
    let businessName = 'Your landlord';
    let replyTo: string | null = null;
    if (prop?.corporation_id) {
      const { data: corp } = await admin
        .from('corporations').select('name, contact_email').eq('id', prop.corporation_id).maybeSingle();
      if (corp?.name) businessName = String(corp.name);
      replyTo = corp?.contact_email ? String(corp.contact_email) : null;
    }

    const logEvent = (kind: string, detail?: Record<string, unknown>) =>
      admin.from('envelope_events').insert({
        owner_id: env.owner_id, envelope_id: env.id, kind, actor: 'tenant',
        ip, user_agent: userAgent(req), detail: detail ?? null,
      });

    // =====================================================================
    // VIEW — the document and the four facts about it. Nothing else.
    // =====================================================================
    if (action === 'view') {
      const { data: signed } = await admin.storage
        .from('lease-documents')
        .createSignedUrl(String(env.storage_path), SIGNED_URL_SECONDS);

      // One 'viewed' event per five minutes. A raw event per request would bury the
      // signature itself in scroll on the certificate page — which is a document a court
      // may one day read.
      const since = new Date(Date.now() - 5 * 60_000).toISOString();
      const { data: recent } = await admin
        .from('envelope_events').select('id')
        .eq('envelope_id', env.id).eq('kind', 'viewed').gte('at', since).limit(1);
      if (!recent?.length) await logEvent('viewed');

      return json({
        state: 'sent',
        title: env.title,
        filename: env.filename,
        message: env.message,
        business_name: businessName,
        property_name: prop?.name ?? null,
        signer_name: signer.name,
        expires_at: env.expires_at,
        document_url: signed?.signedUrl ?? null,
        already_signed: !!signer.signed_at,
      });
    }

    // A second signature from the same link is refused before anything is written.
    if (signer.signed_at) {
      return json({ closed: true, state: 'signed', error: CLOSED_MESSAGE.signed }, 410);
    }

    // =====================================================================
    // DECLINE — a real answer, recorded as one. Nothing is applied.
    // =====================================================================
    if (action === 'decline') {
      await admin.from('signature_envelopes')
        .update({ status: 'declined', declined_reason: reason ? String(reason).slice(0, 2000) : null })
        .eq('id', env.id);
      await logEvent('declined', reason ? { reason: String(reason).slice(0, 500) } : undefined);
      await notifyLandlord(replyTo, businessName, `${signer.name} declined to sign`,
        `${signer.name} declined to sign "${env.title}".` + (reason ? `\n\nReason given: ${String(reason).slice(0, 500)}` : ''));
      return json({ ok: true, state: 'declined' });
    }

    // =====================================================================
    // SIGN — consent, then the signature, then the seal.
    // =====================================================================
    if (consent !== true) {
      return json({ error: 'Please agree to sign electronically before signing.' }, 400);
    }
    const name = String(typed_name ?? '').trim().slice(0, 200);
    if (!name) return json({ error: 'Please type your name.' }, 400);

    // The drawn signature: a PNG data URL and nothing else. Anything that isn't one is
    // rejected outright rather than coerced — this is a file we will hand back to a court.
    const dataUrl = String(signature_png ?? '');
    const prefix = 'data:image/png;base64,';
    if (!dataUrl.startsWith(prefix)) return json({ error: 'Please draw or type your signature.' }, 400);
    let bytes: Uint8Array;
    try {
      const bin = atob(dataUrl.slice(prefix.length));
      if (bin.length > MAX_SIGNATURE_BYTES) return json({ error: 'That signature image is too large.' }, 400);
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return json({ error: 'That signature couldn’t be read.' }, 400);
    }

    const sigPath = `signatures/${env.id}/tenant-${crypto.randomUUID()}.png`;
    const up = await admin.storage.from('lease-documents')
      .upload(sigPath, bytes, { contentType: 'image/png', upsert: false });
    if (up.error) throw up.error;

    const now = new Date().toISOString();
    const { error: sgErr } = await admin.from('envelope_signers').update({
      consent_at: now, signed_at: now, typed_name: name,
      signature_path: sigPath, ip, user_agent: userAgent(req),
      ...placementColumns(placement),
    }).eq('id', signer.id);
    if (sgErr) throw sgErr;

    const { error: envErr } = await admin.from('signature_envelopes')
      .update({ status: 'signed', signed_at: now }).eq('id', env.id);
    if (envErr) throw envErr;

    // Two events, not one: consent and signature are separate legal facts (ESIGN §7001(c)
    // and the intent-to-sign requirement), and the certificate prints them separately.
    await logEvent('consented');
    await logEvent('signed', { typed_name: name });

    await notifyLandlord(replyTo, businessName, `${name} signed ${env.title}`,
      `${name} has signed "${env.title}".\n\nOpen Amlak to add your signature and complete it.`);

    return json({ ok: true, state: 'signed', signer_name: name });
  } catch (e) {
    return serverError(e, 'sign-envelope');
  }
});

// A heads-up to the LANDLORD (never to a tenant — nothing in this function ever emails a
// tenant unprompted). Best-effort: a mail failure must not undo a signature that happened.
async function notifyLandlord(to: string | null, businessName: string, subject: string, text: string) {
  if (!to || !RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `${businessName.replace(/[\r\n"<>]/g, ' ').slice(0, 60)} <${FROM_ADDRESS}>`,
        to: [to], subject, text,
      }),
    });
  } catch (e) {
    console.error('[sign-envelope] landlord notify failed:', e instanceof Error ? e.message : String(e));
  }
}
