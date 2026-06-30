-- 0030_email_2fa.sql
-- Email-based two-factor authentication (custom build — Supabase has no native
-- email MFA factor, only TOTP and phone). Two tables:
--   • user_security: per-user toggle (email_2fa_enabled) + last_2fa_at. The client
--     reads its OWN row to decide whether to challenge at login; the flag is only
--     ever flipped by the verify-2fa-code Edge Function (service role), after the
--     user proves control of their inbox with a valid code.
--   • email_2fa_codes: short-lived ONE-TIME codes, stored as a SHA-256 hash (never
--     plaintext). RLS-enabled with NO policy, so the table is unreachable via the
--     public API — only the send/verify Edge Functions (service role) touch it.

create table if not exists public.user_security (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  email_2fa_enabled boolean     not null default false,
  last_2fa_at       timestamptz,
  updated_at        timestamptz not null default now()
);
alter table public.user_security enable row level security;

-- A user may READ their own security row (to know whether to show the 2FA step).
-- There is deliberately NO write policy: turning 2FA on/off goes through
-- verify-2fa-code (service role), which requires a valid emailed code first.
drop policy if exists user_security_select_own on public.user_security;
create policy user_security_select_own on public.user_security
  for select using (auth.uid() = user_id);

create table if not exists public.email_2fa_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  code_hash   text        not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  attempts    integer     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists email_2fa_codes_user_idx
  on public.email_2fa_codes (user_id, created_at desc);
alter table public.email_2fa_codes enable row level security;
-- No policy on purpose: deny all direct API access. Only the send-2fa-code /
-- verify-2fa-code Edge Functions (service role) read and write this table.
