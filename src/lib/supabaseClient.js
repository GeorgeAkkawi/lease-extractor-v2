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
  if (error) throw error;
  return data;
}
