-- 0052 — server-side enforcement for authenticator (TOTP) two-factor auth.
--
-- The old email-2FA was a CLIENT-side gate only: a valid (aal1) JWT could still
-- read/write the data directly via PostgREST, bypassing the screen. This migration
-- makes 2FA real at the database: once a user has a VERIFIED authenticator factor,
-- their session must be at assurance level aal2 (i.e. they completed a TOTP check)
-- to touch their portfolio data.
--
-- SAFE BY CONSTRUCTION — this does NOT lock anyone out:
--   • A user with NO verified factor is unaffected (the policy's second branch lets
--     aal1 through). Right now there are zero factors enrolled, so nothing changes
--     on deploy — the app behaves exactly as before.
--   • Enforcement only begins for a user AFTER they successfully enroll + verify an
--     authenticator (which itself proves the code works and elevates that session to
--     aal2). On the next login they complete a TOTP challenge to reach aal2.
--   • service_role (cron / edge functions) and anon are not `authenticated`, so the
--     restrictive policy never applies to them — the nightly jobs keep working.
-- Recovery if a device is ever lost: the account owner unenrolls the factor via the
-- admin/service API (auth.mfa_factors), and the user re-enrolls.

-- Does the CURRENT user have a verified MFA factor? SECURITY DEFINER so the policy
-- can consult auth.mfa_factors without granting the authenticated role direct access
-- to the auth schema. STABLE + empty search_path; fully-qualified references.
create or replace function public.user_has_verified_mfa()
  returns boolean
  language sql
  stable
  security definer
  set search_path to ''
as $$
  select exists (
    select 1 from auth.mfa_factors
    where user_id = (select auth.uid()) and status = 'verified'
  );
$$;

revoke all on function public.user_has_verified_mfa() from public;
grant execute on function public.user_has_verified_mfa() to authenticated;

comment on function public.user_has_verified_mfa() is
  'True when the current auth user has a verified MFA factor. Used by the require_aal2 RLS policies so aal2 is enforced only for users who have enrolled 2FA (no factor -> unaffected).';

-- Apply the aal2 requirement to every table that holds the landlord''s portfolio
-- data. RESTRICTIVE => it is ANDed with the existing owner_id policies (owner still
-- required, PLUS aal2 once a factor is verified). With no WITH CHECK clause the USING
-- expression also guards INSERT, so reads and writes are both covered.
do $mfa$
declare
  t text;
  tables text[] := array[
    'alert_states','cam_line_items','corporations','expense_records','expired_leases',
    'financial_snapshots','history_events','insurance_documents','insurance_policies',
    'invoices','key_dates','lease_addendums','lease_files','leases','notifications',
    'payments','properties','reminders','renewal_options','rent_abatements',
    'rent_escalations','service_contracts'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists require_aal2 on public.%I', t);
    execute format(
      'create policy require_aal2 on public.%I '
      'as restrictive to authenticated using ('
      '  (select auth.jwt() ->> ''aal'') = ''aal2'' '
      '  or not public.user_has_verified_mfa()'
      ')', t);
  end loop;
end
$mfa$;
