import { createClient } from '@supabase/supabase-js';
import { mockSupabase } from './demo/mockClient';

const url = process.env.REACT_APP_SUPABASE_URL;
const anonKey = process.env.REACT_APP_SUPABASE_ANON_KEY;

// Demo mode: when no Supabase keys are configured, fall back to an in-memory
// mock with seeded data so the app is fully clickable without any backend.
// Adding real keys to .env.local automatically switches to the live client.
export const DEMO_MODE = !url || !anonKey;

if (DEMO_MODE) {
  // eslint-disable-next-line no-console
  console.info('Running in DEMO mode (no Supabase keys). Add .env.local to use a real backend.');
}

export const supabase = DEMO_MODE ? mockSupabase : createClient(url, anonKey);

// Helper for calling an Edge Function with the current user's JWT attached.
export async function invokeFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    // supabase-js throws a FunctionsHttpError whose .message is the generic
    // "Edge Function returned a non-2xx status code". The real, user-friendly
    // reason is in the function's JSON body ({ error }) on error.context — read
    // it so messages like "This scan is too large…" actually reach the UI.
    let message = error.message;
    try {
      const body = await error.context?.json?.();
      if (body?.error) message = body.error;
    } catch {
      /* keep the default message */
    }
    // A runtime kill (e.g. the edge wall-clock limit) returns no JSON body to read
    // above, so the generic "non-2xx" would surface. Status 546 = the function was
    // terminated (usually because it ran too long) — give a plain, actionable reason.
    if (error.context?.status === 546) {
      message = 'The document took too long to read. Please try again — or if it’s a large scan, split the PDF or upload a smaller/lower-resolution copy.';
    }
    throw new Error(message);
  }
  return data;
}
