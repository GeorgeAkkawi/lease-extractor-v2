// Per-user rate limiting for AI endpoints (cost protection). Returns a 429 Response
// when the caller is over the limit for the window, or null to proceed. Requires a
// caller JWT — the AI endpoints are all authenticated. Fails OPEN on an
// infrastructure error so a limiter hiccup never takes the feature down: the limit
// is a cost safety-net, not the primary auth (RLS + JWT still apply on every call).
//
// On a block, best-effort records a 'rate_limited' event to the security audit log
// (public.security_events via log_security_event, from 0020_security_hardening).
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { json } from './cors.ts';

export async function enforceRateLimit(
  req: Request,
  limit: number,
  windowSeconds: number,
): Promise<Response | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Unauthorized.' }, 401);
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: allowed, error } = await supabase.rpc('ai_rate_check', {
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return null; // fail open on limiter error
    if (allowed === false) {
      await logRateLimited(supabase, req, limit, windowSeconds);
      return json(
        { error: 'Rate limit reached — too many AI requests. Please wait a minute and try again.' },
        429,
      );
    }
    return null; // under limit → proceed
  } catch (_e) {
    return null; // fail open — never block the app on a limiter fault
  }
}

// Best-effort audit log of a rate-limit hit. Any failure (incl. anon callers who
// lack EXECUTE on the logger) is swallowed — auditing must never affect the response.
async function logRateLimited(supabase: any, req: Request, limit: number, windowSeconds: number) {
  try {
    let fn = 'ai';
    try { fn = new URL(req.url).pathname.split('/').filter(Boolean).pop() || 'ai'; } catch { /* keep default */ }
    await supabase.rpc('log_security_event', {
      p_event_type: 'rate_limited',
      p_fn: fn,
      p_detail: `limit ${limit}/${windowSeconds}s exceeded`,
      p_ip: req.headers.get('x-forwarded-for'),
    });
  } catch (_e) {
    /* ignore — auditing is best-effort */
  }
}
