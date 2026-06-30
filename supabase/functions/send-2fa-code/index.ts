// Emails a 6-digit two-factor code to the authenticated user's own address.
// Custom email 2FA (Supabase has no native email MFA factor). The code is stored
// only as a SHA-256 hash with a 10-minute expiry; any still-open codes for the
// user are invalidated first. Rate-limited to curb email abuse / cost. Reuses the
// same Resend sender as send-reminders.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { json, preflight, serverError } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = Deno.env.get('REMINDER_FROM_EMAIL') ?? 'security@example.com';
const CODE_TTL_MS = 10 * 60 * 1000;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Cryptographically-random 6-digit code (000000–999999).
function sixDigitCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, '0');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    // Cap how often a user can request a code (email-abuse + cost guard).
    const limited = await enforceRateLimit(req, 5, 60);
    if (limited) return limited;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized.' }, 401);

    // Identify the caller from their JWT.
    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user?.email) return json({ error: 'Unauthorized.' }, 401);

    if (!RESEND_API_KEY) return json({ error: 'Email sender not configured.' }, 503);

    const code = sixDigitCode();
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

    // Service-role client to write the RLS-locked codes table.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    // Invalidate any still-open codes for this user, then store the new one.
    await admin.from('email_2fa_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('user_id', user.id).is('consumed_at', null);
    const { error: insErr } = await admin.from('email_2fa_codes')
      .insert({ user_id: user.id, code_hash: codeHash, expires_at: expiresAt });
    if (insErr) return json({ error: 'Could not issue a code.' }, 500);

    const ok = await sendEmail(user.email, code);
    if (!ok) return json({ error: 'Could not send the code email.' }, 502);

    return json({ sent: true });
  } catch (e) {
    return serverError(e, 'send-2fa-code');
  }
});

async function sendEmail(to: string, code: string): Promise<boolean> {
  const subject = `Your Amlak verification code: ${code}`;
  const text =
    `Your Amlak verification code is ${code}.\n\n` +
    `It expires in 10 minutes. If you did not just sign in or change your security ` +
    `settings, you can safely ignore this email.`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, text }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}
