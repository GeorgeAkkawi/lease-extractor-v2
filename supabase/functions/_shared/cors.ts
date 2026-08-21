// Origin allowlist for CORS. These functions authenticate via the Authorization
// header (not cookies), so CORS is defense-in-depth, not the primary control —
// but we still don't want arbitrary sites invoking them from a browser.
//
// The allowlist is: the production origin(s) from the ALLOWED_ORIGINS secret
// (comma-separated) OR the built-in default below, PLUS any localhost origin so
// local dev keeps working without configuration. When the request's Origin is on
// the list we reflect it; otherwise we fall back to the first configured origin.
//
// Usage in a function handler (req is in scope):
//   const { preflight, json, serverError } = cors(req);
// then call preflight()/json()/serverError() exactly as before — the response's
// Access-Control-Allow-Origin is resolved once, per request, for that origin.

// Built-in production origin so a deploy WITHOUT the secret is still locked down
// (not wide open). Override/extend via the ALLOWED_ORIGINS secret.
//
// ⚠ THE APP ORIGIN MUST STAY FIRST, because ALLOWLIST[0] is the fallback resolveOrigin()
// returns when a request arrives with no Origin or an unrecognised one — and
// send-for-signature builds the tenant's signing link out of exactly that value
// (`${resolveOrigin(req)}/sign/${token}`). Put the marketing apex first and a signing
// link starts pointing at amlakre.com, which since 2026-08-21 is the public site and
// has no /sign route of its own. (The site worker redirects /sign/* to here so links
// already sent stay signable, but new links should be born correct.)
//
// ⚠ AND THIS FILE IS NOT WHAT'S LIVE. It is imported by ~25 functions (CLAUDE.md §5), so
// editing it would mean redeploying all 25 to take effect. It does not need to be: the
// ALLOWED_ORIGINS secret is set in production and CONFIGURED wins over this list
// entirely. This edit exists so the source agrees with the secret — keep them in step.
const DEFAULT_ORIGINS = [
  'https://app.amlakre.com',
  'https://amlakre.com',
  'https://www.amlakre.com',
  'https://amlak.akkawigeo-5.workers.dev',
];

const CONFIGURED = ((Deno.env.get('ALLOWED_ORIGINS') ?? Deno.env.get('ALLOWED_ORIGIN') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean));

// The effective allowlist: configured origins if provided, else the built-in default.
const ALLOWLIST = CONFIGURED.length ? CONFIGURED : DEFAULT_ORIGINS;

const isLocalhost = (origin: string) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/** Resolve the Access-Control-Allow-Origin value to send back for this request. */
export function resolveOrigin(req?: Request): string {
  const origin = req?.headers.get('origin') ?? '';
  if (origin && (ALLOWLIST.includes(origin) || isLocalhost(origin))) return origin;
  return ALLOWLIST[0];
}

function headersFor(req?: Request) {
  return {
    'Access-Control-Allow-Origin': resolveOrigin(req),
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

// Per-request helpers bound to the caller's (validated) origin. Prefer this in
// handlers: `const { preflight, json, serverError } = cors(req);`
export function cors(req?: Request) {
  const corsHeaders = headersFor(req);
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  return {
    corsHeaders,
    json,
    preflight: () => new Response('ok', { headers: corsHeaders }),
    // Log the full error server-side (for debugging) and return a generic message.
    // Never leak internal/upstream error text (stack traces, SQL, API bodies).
    serverError: (e: unknown, fn: string) => {
      console.error(`[${fn}]`, e instanceof Error ? (e.stack ?? e.message) : String(e));
      return json({ error: 'Something went wrong. Please try again.' }, 500);
    },
  };
}

// ---- Backward-compatible standalone exports ---------------------------------
// Kept so any caller that hasn't adopted cors(req) still works. They resolve the
// origin from the built-in/configured allowlist with no request context (so they
// return the primary allowed origin). Handlers that want per-origin reflection
// should use cors(req) above.
export const corsHeaders = headersFor();

export function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function preflight() {
  return new Response('ok', { headers: corsHeaders });
}

export function serverError(e: unknown, fn: string) {
  console.error(`[${fn}]`, e instanceof Error ? (e.stack ?? e.message) : String(e));
  return json({ error: 'Something went wrong. Please try again.' }, 500);
}
