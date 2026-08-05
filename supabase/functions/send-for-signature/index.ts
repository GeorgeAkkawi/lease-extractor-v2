// Send a document out for signature: mint the signing link, record the envelope, email
// the tenant. The landlord-facing half of e-signature — the tenant's half is sign-envelope,
// which is the only unauthenticated function in this project.
//
// SENDER IDENTITY: identical to send-tenant-email. DMARC forbids sending literally "from"
// an address on a domain we don't own, so — like DocuSign — we send:
//   From:     "{Business name}" <letters@amlakre.com>   (verified domain)
//   Reply-To: the landlord's business email               (replies reach them)
// The business NAME is looked up under the caller's own JWT (RLS), so a landlord can only
// ever borrow one of HIS business names.
//
// AUTH: verify_jwt defaults true (config.toml, no override), but we ALSO do an explicit
// auth.getUser() check — enforceRateLimit fails OPEN on a limiter fault, so it is a cost
// guard, not the gate.
//
// ⚠ THE TOKEN IS RETURNED EXACTLY ONCE AND NEVER STORED. 32 bytes of CSPRNG go into the
// emailed link; only sha256(token) is written to envelope_signers.token_hash. It comes back
// in this response solely so the UI can offer "copy the link" when a landlord would rather
// send it himself — after that it exists only in the tenant's inbox. There is no endpoint
// that can recover it, by design: a leaked database yields no working links.
//
// ⚠ THE DOCUMENT IS HASHED FROM STORAGE, NOT FROM THE CLIENT. The client uploads the file
// and then sends us the path; we download those exact bytes under the caller's own JWT and
// hash them here. A client-supplied hash would be a seal the sealer chose, which is no seal
// at all — this is what makes "these are the bytes they signed" provable later.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors, resolveOrigin } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_ADDRESS = Deno.env.get('TENANT_FROM_EMAIL') ?? 'letters@amlakre.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 0093 — 'service_contract' is the contracts-tab purpose. Unlike the three lease purposes it
// asks the landlord nothing: an executed service contract IS the contract, so there is no
// "does this amend or replace?" question to answer and the send dialog doesn't show one.
const PURPOSES = ['extension', 'new_lease', 'other', 'service_contract'];

// Strip anything that could break the RFC 5322 display-name / header, and cap it.
function sanitizeName(raw: string): string {
  return (raw || '').replace(/[\r\n"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

const sha256Hex = async (bytes: Uint8Array | string) =>
  hex(await crypto.subtle.digest('SHA-256', typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes));

// 32 bytes → 43 base64url chars. URL-safe and unpadded so it survives an email client's
// link parser without escaping.
function mintToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

Deno.serve(async (req) => {
  const { preflight, json, serverError } = cors(req);
  if (req.method === 'OPTIONS') return preflight();

  try {
    // --- Real auth (not just the rate limiter, which fails open) --------------
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

    // Cost/abuse guard: at most 10 envelopes a minute per user.
    const limited = await enforceRateLimit(req, 10, 60);
    if (limited) return limited;

    const body = await req.json().catch(() => ({}));
    const {
      lease_id, contract_id, property_id, renewal_option_id, purpose, title, storage_path,
      filename, message, signer_name, signer_email, expires_at, reply_to, resend_envelope_id,
    } = body ?? {};

    if (!signer_email || !EMAIL_RE.test(String(signer_email))) {
      return json({ error: "That signer's email doesn't look right." }, 400);
    }
    if (reply_to && !EMAIL_RE.test(String(reply_to))) {
      return json({ error: "That reply-to email doesn't look right." }, 400);
    }
    const expiry = new Date(String(expires_at ?? ''));
    if (!expires_at || Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      return json({ error: 'Pick an expiry date in the future.' }, 400);
    }
    if (!RESEND_API_KEY) {
      return json({ error: 'Sending isn’t available right now — copy the link and send it yourself.' }, 503);
    }

    const token = mintToken();
    const token_hash = await sha256Hex(token);
    const who = sanitizeName(String(signer_name ?? '')) || String(signer_email);

    // ---- Either revive an existing envelope, or create a new one ------------
    // A RESEND retires the old token by overwriting its hash — the previous link stops
    // working the instant the new one is minted, which is the behaviour a landlord expects
    // from "send it again" and the reason resend doubles as the fix for an expired link.
    let envelope: Record<string, unknown> | null = null;
    let docTitle = String(title ?? 'Document').slice(0, 300);

    if (resend_envelope_id) {
      const { data: existing, error: exErr } = await supabase
        .from('signature_envelopes')
        .select('id, title, status, lease_id, property_id')
        .eq('id', resend_envelope_id)
        .maybeSingle();
      if (exErr || !existing) return json({ error: 'That envelope no longer exists.' }, 404);
      if (!['sent', 'expired'].includes(String(existing.status))) {
        return json({ error: 'That document has already been signed or cancelled.' }, 409);
      }
      docTitle = String(existing.title);
      const { data: updated, error: upErr } = await supabase
        .from('signature_envelopes')
        .update({ status: 'sent', expires_at: expiry.toISOString(), sent_at: new Date().toISOString() })
        .eq('id', resend_envelope_id)
        .select('id, lease_id, property_id, title')
        .single();
      if (upErr) throw upErr;
      envelope = updated;

      const { error: sgErr } = await supabase
        .from('envelope_signers')
        .update({ token_hash })
        .eq('envelope_id', resend_envelope_id)
        .eq('role', 'tenant');
      if (sgErr) throw sgErr;
    } else {
      // 0093 — an envelope belongs to a lease OR to a service contract, never both and never
      // neither. ck_env_one_owner enforces it in the database; this is the same rule stated
      // where the error message can be readable.
      if (!property_id) return json({ error: 'Missing the property this document belongs to.' }, 400);
      if (!lease_id && !contract_id) return json({ error: 'Missing the lease or contract this document belongs to.' }, 400);
      if (lease_id && contract_id) return json({ error: 'A document belongs to a lease or to a contract, not both.' }, 400);
      if (!storage_path) return json({ error: 'Upload the document first.' }, 400);
      if (!title || !String(title).trim()) return json({ error: 'Give the document a title.' }, 400);
      if (purpose && !PURPOSES.includes(String(purpose))) return json({ error: 'Unknown document type.' }, 400);

      // Hash the real bytes, under the caller's own JWT — see the header.
      const dl = await supabase.storage.from('lease-documents').download(String(storage_path));
      if (dl.error || !dl.data) return json({ error: 'Couldn’t read that document — try uploading it again.' }, 400);
      const doc_sha256 = await sha256Hex(new Uint8Array(await dl.data.arrayBuffer()));

      const { data: created, error: envErr } = await supabase
        .from('signature_envelopes')
        .insert({
          owner_id: user.id,
          lease_id: lease_id ?? null,
          contract_id: contract_id ?? null,
          property_id,
          renewal_option_id: renewal_option_id ?? null,
          purpose: purpose ?? 'other',
          title: docTitle,
          storage_path,
          filename: filename ?? null,
          doc_sha256,
          message: message ? String(message).slice(0, 5000) : null,
          status: 'sent',
          expires_at: expiry.toISOString(),
        })
        .select('id, lease_id, property_id, title')
        .single();
      if (envErr) throw envErr;
      envelope = created;

      // The tenant row HOLDS the link. The landlord row deliberately does not — he signs
      // inside the app under his own session, and must never have a bearer link to his
      // own document.
      const { error: sgErr } = await supabase.from('envelope_signers').insert([
        {
          owner_id: user.id, envelope_id: created.id, role: 'tenant',
          name: who, email: String(signer_email), token_hash,
        },
        {
          owner_id: user.id, envelope_id: created.id, role: 'landlord',
          name: sanitizeName(String(body?.landlord_name ?? '')) || 'Landlord',
          email: reply_to ? String(reply_to) : null, token_hash: null,
        },
      ]);
      if (sgErr) throw sgErr;

      await supabase.from('envelope_events').insert({
        owner_id: user.id, envelope_id: created.id, kind: 'created', actor: 'landlord',
        detail: { doc_sha256, filename: filename ?? null },
      });
    }

    const envId = String(envelope!.id);

    // --- Sender display name: the landlord's OWN business named by reply_to --
    let displayName = 'Amlak';
    if (reply_to) {
      const { data: corps } = await supabase
        .from('corporations').select('name').eq('contact_email', reply_to).limit(1);
      const name = sanitizeName(corps?.[0]?.name ?? '');
      if (name) displayName = name;
    }

    // The link is built from the request's OWN validated origin (cors.ts allowlist), so a
    // send from localhost during development produces a localhost link and anything not on
    // the allowlist falls back to production — never to an attacker-supplied host.
    const signUrl = `${resolveOrigin(req)}/sign/${token}`;

    const note = message ? `${String(message).trim()}\n\n` : '';
    const text =
      `${who},\n\n` +
      `${note}` +
      `Please review and sign: ${docTitle}\n\n` +
      `${signUrl}\n\n` +
      `The link expires ${expiry.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. ` +
      `You don't need an account — the page opens straight to the document.\n\n` +
      `${displayName}`;

    const payload: Record<string, unknown> = {
      from: `${displayName} <${FROM_ADDRESS}>`,
      to: [String(signer_email)],
      subject: `Please sign: ${docTitle}`,
      text,
    };
    if (reply_to) payload.reply_to = String(reply_to);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error('[send-for-signature] Resend rejected:', res.status, await res.text().catch(() => ''));
      // The envelope and its link are REAL at this point — only the delivery failed. Say so
      // and hand back the link rather than leaving a live envelope nobody was told about.
      await supabase.from('envelope_events').insert({
        owner_id: user.id, envelope_id: envId, kind: 'created', actor: 'system',
        detail: { email_failed: true },
      });
      return json({
        envelope_id: envId, sign_url: signUrl, emailed: false,
        error: 'The document is ready but the email didn’t go out — copy the link and send it yourself.',
      }, 200);
    }

    await supabase.from('envelope_events').insert({
      owner_id: user.id, envelope_id: envId, kind: 'sent', actor: 'landlord',
      detail: { to: String(signer_email) },
    });

    return json({ envelope_id: envId, sign_url: signUrl, emailed: true });
  } catch (e) {
    return serverError(e, 'send-for-signature');
  }
});
