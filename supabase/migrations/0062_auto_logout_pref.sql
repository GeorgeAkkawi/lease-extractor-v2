-- 0062_auto_logout_pref.sql
-- Auto sign-out preference: how many idle minutes before the app signs the user
-- out of this browser. Stored on the existing per-user user_preferences row (same
-- place as hidden_widgets / enabled_features / lease_sort).
--
-- Additive / non-destructive: a single nullable column on an existing table — no
-- data touched, no view/function/policy changes (the existing user_preferences RLS
-- already scopes the row to its owner). Safe to re-run (ADD COLUMN IF NOT EXISTS).
--
-- Semantics (interpreted in the app, not the DB):
--   • NULL  — the user has never chosen → the app default (30 minutes) applies.
--   •   0   — off (never auto-sign-out).
--   • > 0   — sign out after that many idle minutes.

alter table public.user_preferences
  add column if not exists auto_logout_minutes integer;
