-- 0043_enabled_features.sql
-- Which optional feature modules the landlord has switched on. Part of the same
-- per-user preferences row as hidden_widgets (migration 0038), client-writable
-- under the existing RLS policy — the user flips features from the Settings page,
-- no Edge Function needed.
--
-- Semantics of enabled_features:
--   NULL   = the user has never chosen (a fresh account). The app shows the
--            one-time onboarding picker and, until they choose, treats every
--            optional module as ON.
--   jsonb array of keys = the explicit set of optional modules they want ON.
-- Turning a module off only hides it everywhere; its data is never deleted.

alter table public.user_preferences
  add column if not exists enabled_features jsonb;
