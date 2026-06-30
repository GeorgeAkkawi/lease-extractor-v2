// Origin allowlist for CORS. In production set ALLOWED_ORIGIN to your app's
// origin (e.g. "https://app.example.com") as an Edge Function secret so other
// sites can't call these functions from a browser. Defaults to "*" so local dev
// works out of the box. (Requests are authenticated via the Authorization header,
// not cookies, so this is defense-in-depth, not the primary control. For multiple
// origins, switch to per-request Origin reflection against an allowlist.)
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

export const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

export function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function preflight() {
  return new Response('ok', { headers: corsHeaders });
}

// Log the full error to the function logs (server-side only, for debugging) and
// return a generic message to the client. Never leak internal/upstream error
// text (stack traces, SQL errors, third-party API bodies) to callers.
export function serverError(e: unknown, fn: string) {
  console.error(`[${fn}]`, e instanceof Error ? (e.stack ?? e.message) : String(e));
  return json({ error: 'Something went wrong. Please try again.' }, 500);
}
