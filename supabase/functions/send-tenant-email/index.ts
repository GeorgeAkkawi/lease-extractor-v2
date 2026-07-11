// Landlord-initiated tenant email sender. The landlord clicks "Send now" on a
// letter (renewal notice, insurance request, invoice) and the app delivers it
// directly via Resend — no Gmail/mail-app round trip. It NEVER auto-sends; a
// letter goes out only on an explicit click, and the recipient/subject/body are
// exactly what the landlord sees in the compose box.
//
// SENDER IDENTITY (the one anti-spoofing constraint): DMARC forbids sending
// literally "from" an address on a domain we don't own (e.g. a landlord's
// @gmail.com), so — like DocuSign/QuickBooks — we send:
//   From:     "{Business name}" <letters@amlakre.com>   (verified domain)
//   Reply-To: the landlord's business email               (replies reach them)
// The tenant sees the business NAME; hitting Reply goes to the business inbox.
//
// AUTH: verify_jwt defaults true (config.toml, no override), but we ALSO do an
// explicit auth.getUser() check — enforceRateLimit fails OPEN on a limiter fault,
// so it's a cost guard, not the gate. The corporation name is looked up under the
// caller's own JWT (RLS), so a landlord can only ever borrow one of HIS business
// names as the display name.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
// From-address on the verified domain. Overridable, but must stay a domain we own.
const FROM_ADDRESS = Deno.env.get('TENANT_FROM_EMAIL') ?? 'letters@amlakre.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Strip anything that could break the RFC 5322 display-name / header, and cap it.
function sanitizeName(raw: string): string {
  return (raw || '')
    .replace(/[\r\n"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

Deno.serve(async (req) => {
  const { preflight, json, serverError } = cors(req);
  if (req.method === 'OPTIONS') return preflight();

  try {
    // --- Real auth (not just the rate limiter, which fails open) -------------
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

    // Cost/abuse guard: at most 10 sends per minute per user.
    const limited = await enforceRateLimit(req, 10, 60);
    if (limited) return limited;

    // --- Validate the message ------------------------------------------------
    const { to, subject, body, reply_to } = await req.json().catch(() => ({}));
    if (!to || !EMAIL_RE.test(String(to))) {
      return json({ error: "That recipient email doesn't look right." }, 400);
    }
    if (reply_to && !EMAIL_RE.test(String(reply_to))) {
      return json({ error: "That reply-to email doesn't look right." }, 400);
    }
    const subj = String(subject ?? '').trim();
    const text = String(body ?? '').trim();
    if (!subj) return json({ error: 'Add a subject before sending.' }, 400);
    if (!text) return json({ error: 'The message is empty.' }, 400);
    if (subj.length > 300) return json({ error: 'That subject is too long.' }, 400);
    if (text.length > 50000) return json({ error: 'That message is too long.' }, 400);

    if (!RESEND_API_KEY) {
      // Domain/key not configured — steer to the Gmail button instead of failing silently.
      return json({ error: 'Direct sending isn’t available right now — use the Gmail button.' }, 503);
    }

    // --- Sender display name: the landlord's OWN business named by reply_to ---
    // RLS scopes this to the caller's corporations. Duplicate contact_emails across
    // corporations are possible, so take the first match (not maybeSingle, which errors).
    let displayName = 'Amlak';
    if (reply_to) {
      const { data: corps } = await supabase
        .from('corporations')
        .select('name')
        .eq('contact_email', reply_to)
        .limit(1);
      const name = sanitizeName(corps?.[0]?.name ?? '');
      if (name) displayName = name;
    }

    // --- Deliver via Resend --------------------------------------------------
    const payload: Record<string, unknown> = {
      from: `${displayName} <${FROM_ADDRESS}>`,
      to: [String(to)],
      subject: subj,
      text,
    };
    if (reply_to) payload.reply_to = String(reply_to);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error('[send-tenant-email] Resend rejected:', res.status, await res.text().catch(() => ''));
      return json({ error: 'Couldn’t send the email — try the Gmail button instead.' }, 502);
    }
    const out = await res.json().catch(() => ({}));
    return json({ id: out?.id ?? null });
  } catch (e) {
    return serverError(e, 'send-tenant-email');
  }
});
