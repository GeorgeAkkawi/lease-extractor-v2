-- 0022_lease_lifecycle_engine.sql
-- Phase A: make Postgres a faithful mirror of the (demo-tested) JS auto-apply
-- engines in src/lib/api.js, so scheduled cron and the in-app on-load engines
-- produce identical results — no drift. Two gaps this closes:
--   1) There was NO server-side escalation engine at all → rent went stale in the
--      financial views until someone opened the browser. Add apply_due_escalations().
--   2) apply_due_renewals() (0020) was single-step, ignored is_active, and notified
--      for ancient catch-up rolls. Upgrade it to match the JS: skip parked
--      (is_active=false) leases, catch up through EVERY due option in one pass, and
--      only notify for a recently-ended term (≤31 days) so a back-dated lease can't
--      flood the inbox. Natural expiry NEVER auto-changes is_active (holdover rule).
--
-- Parity contract with JS: recency window = 31 days; renewals skip is_active=false;
-- escalations set base_rent = the row's new_base_rent (absolute) applied in date
-- order. All hardened like 0020 (security definer, search_path pinned, EXECUTE
-- revoked from clients → scheduler-only).

-- ===========================================================================
-- apply_due_escalations() — NEW. Mirrors JS applyDueEscalations + applyEscalation.
-- ===========================================================================
create or replace function public.apply_due_escalations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  e record;
  l record;
  v_prop record;
  v_count integer := 0;
begin
  for e in
    select esc.*
      from public.rent_escalations esc
     where esc.status = 'scheduled'
       and esc.effective_date <= current_date
     order by esc.effective_date
  loop
    -- Make the increase real: mark applied + set the lease's actual base rent.
    update public.rent_escalations set status = 'applied', applied_at = now() where id = e.id;
    update public.leases set base_rent = e.new_base_rent where id = e.lease_id;

    -- Notify (with a ready-to-send tenant note) only for a recently-crossed
    -- increase; ancient catch-up (e.g. a historical lease) applies silently.
    if e.effective_date >= current_date - interval '31 days' then
      select * into l from public.leases where id = e.lease_id;
      select * into v_prop from public.properties where id = l.property_id;
      insert into public.notifications
        (owner_id, lease_id, property_id, corporation_id, kind, title, body, email_subject, email_body, read)
      values (
        l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'escalation_applied',
        'Rent escalation applied — ' || l.tenant_name,
        'Effective ' || to_char(e.effective_date, 'FMMonth FMDD, YYYY') || ' · base rent now ' || to_char(e.new_base_rent, 'FM$999,999,999'),
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
$$;

-- ===========================================================================
-- apply_due_renewals() — UPGRADE. Mirrors the JS applyDueRenewals while-loop.
-- ===========================================================================
create or replace function public.apply_due_renewals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  r record;
  v_prop record;
  v_new_start date;
  v_new_end date;
  v_old_rent numeric;
  v_new_rent numeric;
  v_term date;
  v_start date;
  v_rent numeric;
  v_guard integer;
  v_count integer := 0;
begin
  for l in
    select * from public.leases
     where is_active                                   -- parked/outdated leases wait for an extension
       and lease_termination_date is not null
       and lease_termination_date <= current_date
  loop
    select * into v_prop from public.properties where id = l.property_id;

    -- Local term/rent state so we can roll through MULTIPLE due options in one pass.
    v_term  := l.lease_termination_date;
    v_start := l.lease_start;
    v_rent  := coalesce(l.base_rent, 0);
    v_guard := 0;

    while v_term is not null and v_term <= current_date and v_guard < 60 loop
      v_guard := v_guard + 1;

      select * into r
        from public.renewal_options
       where lease_id = l.id and status = 'pending'
       order by notice_by_date nulls last
       limit 1;
      exit when not found;

      v_new_start := v_term;
      v_new_end   := v_term + make_interval(months => coalesce(r.term_months, 12));
      v_old_rent  := v_rent;
      v_new_rent  := coalesce(r.new_rent, v_old_rent);

      -- 1) archive the prior term into History
      insert into public.expired_leases (owner_id, property_id, tenant_name, sf, base_rent, lease_start, lease_end, status, note)
      values (l.owner_id, l.property_id, l.tenant_name, l.square_footage, v_old_rent, v_start, v_term,
              'Renewed', 'Auto-renewed (' || coalesce(r.option_label, 'renewal option') || ') — new term through ' || v_new_end);

      -- 2) roll the live lease into the new term + rent
      update public.leases
         set lease_start = v_new_start, lease_termination_date = v_new_end, base_rent = v_new_rent
       where id = l.id;

      -- 3) mark the option applied so it never re-runs
      update public.renewal_options set status = 'applied', applied_at = now() where id = r.id;

      -- 4) notify only for a recently-ended term (skip ancient catch-up rolls)
      if v_new_start >= current_date - interval '31 days' then
        insert into public.notifications
          (owner_id, lease_id, property_id, corporation_id, kind, title, body, email_subject, email_body, read)
        values (
          l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'renewal_applied',
          'Lease renewed — ' || l.tenant_name,
          'Term extended to ' || v_new_end || ' · base rent now ' || to_char(v_new_rent, 'FM$999,999,999'),
          'Lease renewal — ' || coalesce(v_prop.name, 'your space') || ' (effective ' || to_char(v_new_start, 'FMMonth FMDD, YYYY') || ')',
          'Dear ' || l.tenant_name || E',\n\nThis note confirms that your lease has renewed. The new term runs ' ||
            to_char(v_new_start, 'FMMonth FMDD, YYYY') || ' through ' || to_char(v_new_end, 'FMMonth FMDD, YYYY') ||
            '. Your new annual base rent is ' || to_char(v_new_rent, 'FM$999,999,999') ||
            E'. Please update your records and remit the new amount beginning with the renewed term.\n\nThank you,\nProperty Management',
          false
        );
      end if;

      -- advance local state for the next catch-up iteration
      v_start := v_new_start;
      v_term  := v_new_end;
      v_rent  := v_new_rent;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

-- ===========================================================================
-- apply_due_changes() — the single entry point cron calls (escalations, then renewals).
-- ===========================================================================
create or replace function public.apply_due_changes()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer := 0;
begin
  n := n + public.apply_due_escalations();
  n := n + public.apply_due_renewals();
  return n;
end;
$$;

-- Scheduler-only: clients never invoke these (the app applies changes via JS with
-- the user's own JWT; the server path is for cron). Re-assert on the upgraded fn.
revoke all on function public.apply_due_escalations() from public, anon, authenticated;
revoke all on function public.apply_due_renewals()    from public, anon, authenticated;
revoke all on function public.apply_due_changes()     from public, anon, authenticated;

-- ===========================================================================
-- Schedule it. Safe to run whether or not pg_cron is enabled yet: if the cron
-- schema is absent the migration just prints how to schedule it later.
-- ===========================================================================
do $$
begin
  perform cron.schedule('apply-due-lease-changes', '0 6 * * *', 'select public.apply_due_changes();');
exception when others then
  raise notice 'pg_cron not enabled — after enabling it, run: select cron.schedule(''apply-due-lease-changes'', ''0 6 * * *'', ''select public.apply_due_changes();'');';
end;
$$;
