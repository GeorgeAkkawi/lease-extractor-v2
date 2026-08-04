import { DEMO_MODE, supabase } from './supabaseClient';

// The tenant's ONLY connection to Amlak.
//
// ⚠ THIS IS DELIBERATELY A BARE fetch, NOT supabase.functions.invoke. The signing page is
// reached by someone with no account, and the whole security story rests on that page having
// no path into app data — so it sends no Authorization header, no apikey, and never touches
// a table. One POST to one function, which is itself gated by the token and nothing else
// (see supabase/functions/sign-envelope/index.ts).
//
// The DEMO branch below routes to the in-memory mock, which is not a network client at all —
// in production DEMO_MODE is false and that branch is dead. Keeping the sandbox able to show
// the tenant's view is worth the one import.
const FN_URL = `${import.meta.env.REACT_APP_SUPABASE_URL || ''}/functions/v1/sign-envelope`;

export async function callSignEndpoint(payload) {
  if (DEMO_MODE) {
    const { data, error } = await supabase.functions.invoke('sign-envelope', { body: payload });
    // Order matters: the mock reports a CLOSED envelope through both channels (it carries a
    // real explanation for the tenant), and that must surface as the 410 the page renders as
    // a calm state — not as the generic failure an `error`-first check would produce.
    if (data?.not_found) throw Object.assign(new Error(data.error), { status: 404, payload: data });
    if (data?.closed) throw Object.assign(new Error(data.error), { status: 410, payload: data });
    if (error) throw Object.assign(new Error(error.message || 'Something went wrong.'), { status: 400 });
    return data;
  }

  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 410 carries a real explanation for the tenant ("already signed", "expired") — the page
    // shows it as a state, not as a failure, so the status and body ride along on the error.
    throw Object.assign(new Error(data?.error || 'Something went wrong. Please try again.'), {
      status: res.status,
      payload: data,
    });
  }
  return data;
}
