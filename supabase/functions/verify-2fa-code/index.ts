// Verifies a 6-digit email two-factor code for the authenticated user. On success
// it burns the code, stamps last_2fa_at, and — for intent 'enable' / 'disable' —
// flips the user's email_2fa_enabled flag (so 2FA can only be turned on or off by
// someone who controls the inbox). Codes are single-use, expire in 10 minutes, and
// lock after 5 wrong attempts.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { json, preflight, serverError } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

const MAX_ATTEMPTS = 5;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time hex compare so verification time doesn't leak how close a guess was.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return preflight();
  try {
    const limited = await enforceRateLimit(req, 10, 60);
    if (limited) return limited;

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorized.' }, 401);

    const { code, intent } = await req.json().catch(() => ({}));
    const cleanCode = String(code ?? '').trim();
    const act = intent === 'enable' || intent === 'disable' ? intent : 'login';
    if (!/^\d{6}$/.test(cleanCode)) return json({ verified: false, error: 'Enter the 6-digit code.' }, 400);

    const userClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) return json({ error: 'Unauthorized.' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Newest still-open code for this user.
    const { data: rows } = await admin.from('email_2fa_codes')
      .select('*').eq('user_id', user.id).is('consumed_at', null)
      .order('created_at', { ascending: false }).limit(1);
    const row = rows?.[0];
    if (!row) return json({ verified: false, error: 'No active code — request a new one.' }, 400);

    if (new Date(row.expires_at).getTime() < Date.now()) {
      await admin.from('email_2fa_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
      return json({ verified: false, error: 'Code expired — request a new one.' }, 400);
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await admin.from('email_2fa_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
      return json({ verified: false, error: 'Too many attempts — request a new code.' }, 429);
    }

    if (!safeEqual(await sha256Hex(cleanCode), row.code_hash)) {
      await admin.from('email_2fa_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
      return json(
        { verified: false, error: 'Incorrect code.', attempts_left: MAX_ATTEMPTS - (row.attempts + 1) },
        400,
      );
    }

    // Success: burn the code, stamp the verification, apply enable/disable.
    await admin.from('email_2fa_codes').update({ consumed_at: new Date().toISOString() }).eq('id', row.id);
    const patch: Record<string, unknown> = {
      user_id: user.id,
      last_2fa_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (act === 'enable') patch.email_2fa_enabled = true;
    if (act === 'disable') patch.email_2fa_enabled = false;
    await admin.from('user_security').upsert(patch, { onConflict: 'user_id' });

    return json({ verified: true, intent: act });
  } catch (e) {
    return serverError(e, 'verify-2fa-code');
  }
});
