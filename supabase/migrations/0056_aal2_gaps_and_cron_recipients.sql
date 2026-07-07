-- 0056_aal2_gaps_and_cron_recipients.sql
-- Two small hardening items from the 2026-07-07 review (S-1, R-2). Additive /
-- non-destructive; both are create-or-replace / add-policy only.
--
-- 1) S-1 — close the aal2 (2FA) enforcement gaps. Migration 0052 put the
--    require_aal2 RESTRICTIVE policy on the 22 owner-scoped data tables but missed
--    four: user_preferences and portfolio_qa_cache (client-readable — the QA cache
--    holds cached Ask-Amlak answers naming tenants, balances and insurance status,
--    readable by a bare-password aal1 session), plus the dormant email-2FA pair
--    user_security / email_2fa_codes (belt-and-braces; they have no client-facing
--    permissive policies today). Same policy text as 0052: dormant for a user with
--    no verified factor, so nothing changes until 2FA is enrolled.
--
-- 2) R-2 — cron-written escalation notifications get their recipients. The nightly
--    apply_due_escalations() inserted 'escalation_applied' notifications with a
--    ready-to-send subject/body but NO email_to — the send modal opened with a blank
--    "To". Recreate the function byte-identical to 0051 except the INSERT now carries
--    the lease's tenant_email / tenant_email_2.

-- ---- 1) require_aal2 on the four missed tables --------------------------------
do $mfa$
declare
  t text;
  tables text[] := array[
    'user_preferences', 'portfolio_qa_cache', 'user_security', 'email_2fa_codes'
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

-- ---- 2) apply_due_escalations: notification INSERT gains email_to / email_to_2 --
create or replace function public.apply_due_escalations()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  e record;
  l record;
  v_prop record;
  v_count integer := 0;
begin
  for e in
    -- Alias the joined leases table `lse` (not `l`) to avoid colliding with the
    -- PL/pgSQL `l record` variable assigned later in the loop body.
    select esc.*
      from public.rent_escalations esc
      join public.leases lse on lse.id = esc.lease_id
     where esc.status = 'scheduled'
       and esc.effective_date <= public.app_today()
       -- Term-end gate: a step dated on/after the committed termination date is an
       -- un-exercised renewal option's rent — leave it scheduled until the renewal
       -- is confirmed (which extends the term and pulls the step back inside it).
       and (lse.lease_termination_date is null or esc.effective_date < lse.lease_termination_date)
     order by esc.effective_date
  loop
    -- Make the increase real: mark applied + set the lease's actual base rent.
    update public.rent_escalations set status = 'applied', applied_at = now() where id = e.id;
    update public.leases set base_rent = e.new_base_rent where id = e.lease_id;

    -- Notify (with a ready-to-send tenant note) only for a recently-crossed
    -- increase; ancient catch-up (e.g. a historical lease) applies silently.
    if e.effective_date >= public.app_today() - interval '31 days' then
      select * into l from public.leases where id = e.lease_id;
      select * into v_prop from public.properties where id = l.property_id;
      insert into public.notifications
        (owner_id, lease_id, property_id, corporation_id, kind, title, body,
         email_to, email_to_2, email_subject, email_body, read)
      values (
        l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'escalation_applied',
        'Rent escalation applied — ' || l.tenant_name,
        'Effective ' || to_char(e.effective_date, 'FMMonth FMDD, YYYY') || ' · base rent now ' || to_char(e.new_base_rent, 'FM$999,999,999'),
        l.tenant_email, l.tenant_email_2,
        'Rent adjustment — ' || coalesce(v_prop.name, 'your space') || ' (effective ' || to_char(e.effective_date, 'FMMonth FMDD, YYYY') || ')',
        'Dear ' || l.tenant_name || E',\n\nThis confirms that your annual base rent has been adjusted, effective ' ||
          to_char(e.effective_date, 'FMMonth FMDD, YYYY') || ', to ' || to_char(e.new_base_rent, 'FM$999,999,999') ||
          E'. Please update your records and remit the new amount beginning with that period.\n\nThank you,\nProperty Management',
        false
      );
    end if;

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- Keep the hardened grants (create-or-replace preserves them, but be explicit).
revoke all on function public.apply_due_escalations() from public, anon, authenticated;
