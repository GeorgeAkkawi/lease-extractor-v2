// Landlord-initiated BUILDING-WIDE announcement sender. The landlord writes one notice in
// the Announcements window on a property card, ticks who gets it, confirms, and every
// selected tenant receives their own copy. It NEVER auto-sends; a notice goes out only on
// an explicit click, and the recipients/subject/body are exactly what the landlord saw.
//
// WHY THIS EXISTS RATHER THAN A CLIENT-SIDE LOOP OVER send-tenant-email. That function is
// rate-limited to 10 sends per minute per user (a deliberate cost guard), so a building
// with eleven tenants would fail halfway through with some tenants mailed and some not —
// the worst possible outcome for a notice. One invocation that takes the whole list is
// both correct and one round trip instead of N.
//
// INDIVIDUAL SENDS, NOT BCC. Each tenant gets a normal one-to-one email. A BCC blast
// reads as bulk mail, is far likelier to be filtered, and would expose the recipient
// count. The cost is that a partial failure is possible — so this returns per-recipient
// results and the UI reports them honestly rather than claiming a clean sweep.
//
// SENDER IDENTITY — identical to send-tenant-email, and for the same reason: DMARC forbids
// sending literally "from" an address on a domain we don't own, so we send
//   From:     "{Business name}" <letters@amlakre.com>   (verified domain)
//   Reply-To: the landlord's business email               (replies reach them)
// The business NAME is looked up under the caller's own JWT (RLS), so a landlord can only
// ever borrow one of HIS business names as the display name.
//
// AUTH: verify_jwt defaults true (config.toml, no override), but we ALSO do an explicit
// auth.getUser() check — enforceRateLimit fails OPEN on a limiter fault, so it is a cost
// guard, not the gate.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
// From-address on the verified domain. Overridable, but must stay a domain we own.
// Shared with send-tenant-email on purpose: one sending identity for landlord letters.
const FROM_ADDRESS = Deno.env.get('TENANT_FROM_EMAIL') ?? 'letters@amlakre.com';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One property's tenant list. Well above any real building, low enough that a bug or a
// pasted list can't turn into a mass mailing.
const MAX_RECIPIENTS = 60;

// Resend's free tier limits request RATE, not just monthly volume. Two in flight with a
// short pace between waves keeps a 40-tenant building comfortably inside it; a building
// that size takes ~12s, which the UI shows as progress rather than hiding.
const CONCURRENCY = 2;
const PACE_MS = 550;

// Strip anything that could break the RFC 5322 display-name / header, and cap it.
function sanitizeName(raw: string): string {
  return (raw || '')
    .replace(/[\r\n"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    // Cost/abuse guard: at most 3 announcement batches per minute.
    const limited = await enforceRateLimit(req, 3, 60);
    if (limited) return limited;

    // --- Validate the message ------------------------------------------------
    const { recipients, subject, body, reply_to } = await req.json().catch(() => ({}));

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return json({ error: 'Pick at least one tenant to send this to.' }, 400);
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return json({ error: `An announcement can go to at most ${MAX_RECIPIENTS} tenants at once.` }, 400);
    }

    // Dedupe case-insensitively: two leases sharing a contact address must not mean two
    // copies of the same notice landing in one inbox.
    const seen = new Set<string>();
    const to: string[] = [];
    for (const r of recipients) {
      const addr = String((typeof r === 'string' ? r : r?.to) ?? '').trim();
      if (!addr || !EMAIL_RE.test(addr)) {
        return json({ error: `That recipient email doesn't look right: ${addr.slice(0, 60) || '(blank)'}` }, 400);
      }
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      to.push(addr);
    }

    if (reply_to && !EMAIL_RE.test(String(reply_to))) {
      return json({ error: "That reply-to email doesn't look right." }, 400);
    }
    const subj = String(subject ?? '').trim();
    const text = String(body ?? '').trim();
    if (!subj) return json({ error: 'Add a subject before sending.' }, 400);
    if (!text) return json({ error: 'The announcement is empty.' }, 400);
    if (subj.length > 300) return json({ error: 'That subject is too long.' }, 400);
    if (text.length > 50000) return json({ error: 'That announcement is too long.' }, 400);

    if (!RESEND_API_KEY) {
      // Domain/key not configured — steer to the Copy button instead of failing silently.
      return json({ error: 'Direct sending isn’t available right now — use Copy and send it from your own email.' }, 503);
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

    // --- Deliver via Resend, one message per tenant --------------------------
    const sent: Array<{ to: string; id: string | null }> = [];
    const failed: Array<{ to: string; error: string }> = [];

    async function deliver(addr: string) {
      const payload: Record<string, unknown> = {
        from: `${displayName} <${FROM_ADDRESS}>`,
        to: [addr],
        subject: subj,
        text,
      };
      if (reply_to) payload.reply_to = String(reply_to);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          console.error('[send-announcement] Resend rejected:', res.status, detail);
          failed.push({ to: addr, error: res.status === 429 ? 'Rate limited — try again in a minute.' : 'Rejected by the mail service.' });
          return;
        }
        const out = await res.json().catch(() => ({}));
        sent.push({ to: addr, id: out?.id ?? null });
      } catch (err) {
        console.error('[send-announcement] send threw:', err);
        failed.push({ to: addr, error: 'Network error while sending.' });
      }
    }

    for (let i = 0; i < to.length; i += CONCURRENCY) {
      await Promise.all(to.slice(i, i + CONCURRENCY).map(deliver));
      if (i + CONCURRENCY < to.length) await sleep(PACE_MS);
    }

    // 502 only when EVERY send failed — a partial success must still tell the landlord
    // exactly who got it, so the client can show the split rather than a bare error.
    if (sent.length === 0) {
      return json({ error: 'Couldn’t send the announcement — no tenant received it.', sent, failed }, 502);
    }
    return json({ sent, failed });
  } catch (e) {
    return serverError(e, 'send-announcement');
  }
});
