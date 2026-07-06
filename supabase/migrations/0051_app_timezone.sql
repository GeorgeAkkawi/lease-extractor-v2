-- 0051 — pin "today" to the app's business timezone (America/New_York).
--
-- Why: the app's dates (lease terms, escalation/renewal due dates) are calendar
-- dates in the landlord's local (Eastern) day. The nightly cron compared them
-- against `current_date`, which is the DATABASE session date (UTC). At the cron's
-- 13:00 UTC run time the UTC date already equals the Eastern date, so there is no
-- live off-by-one today — but that's a coincidence of the schedule, not a
-- guarantee. Anchoring to Eastern makes "today" mean the same calendar day
-- everywhere, so an off-hours/manual run near UTC midnight can't fire a day early
-- or late.
--
-- This migration is behavior-neutral at the current 13:00 UTC schedule: every
-- function below is byte-identical to its live definition except that the
-- date-comparison `current_date` is replaced with `public.app_today()`. No logic,
-- signatures, grants, or search_path settings change.

-- Single source of truth for "today" in the app's timezone. STABLE (depends on
-- now()); qualified/hardened search_path so it's safe to call from SECURITY
-- DEFINER functions that run with an empty search_path.
create or replace function public.app_today()
  returns date
  language sql
  stable
  set search_path to ''
as $$ select (now() at time zone 'America/New_York')::date $$;

comment on function public.app_today() is
  'Current calendar date in the app business timezone (America/New_York). Use instead of current_date for due-date logic so "today" is consistent regardless of the DB session timezone.';

-- ---- apply_due_escalations: current_date -> public.app_today() ----------------
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
$function$;

-- ---- apply_due_renewals: current_date -> public.app_today() -------------------
create or replace function public.apply_due_renewals()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  l record;
  r record;
  v_prop record;
  v_years int;
  v_rent_label text;
  v_trigger date;
  v_count integer := 0;
begin
  -- Clear stale prompts for leases whose term has since ended (option lapsed).
  delete from public.notifications n
   using public.leases lz
   where n.lease_id = lz.id
     and n.kind = 'renewal_decision'
     and lz.lease_termination_date is not null
     and lz.lease_termination_date < public.app_today();

  for l in
    select * from public.leases
     where is_active
       and lease_termination_date is not null
       and lease_termination_date >= public.app_today()   -- term not yet ended
  loop
    select * into r
      from public.renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    continue when not found;

    -- a bit before the deadline: notice-by date if stated, else ~6 months before term end
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - interval '6 months')::date);
    continue when public.app_today() < v_trigger;

    perform 1 from public.notifications where lease_id = l.id and kind = 'renewal_decision';
    continue when found;

    select * into v_prop from public.properties where id = l.property_id;
    v_years := floor(coalesce(r.term_months, 12) / 12.0)::int;
    v_rent_label := case
      when r.new_rent is not null then to_char(r.new_rent, 'FM$999,999,999')
      when coalesce(r.annual_escalation_pct, 0) > 0 then '+' || r.annual_escalation_pct || '%/yr'
      else 'the current rent' end;

    insert into public.notifications
      (owner_id, lease_id, property_id, corporation_id, kind, title, body, read)
    values (
      l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'renewal_decision',
      'Is ' || l.tenant_name || ' renewing?',
      coalesce(r.option_label, 'A renewal option') || ' — ' || v_years ||
        '-yr extension at ' || v_rent_label ||
        '. Confirm only if the tenant is exercising it; it won''t change the term until you do.',
      false
    )
    on conflict (lease_id) where kind = 'renewal_decision' do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- ---- regenerate_lease_reminders: current_date -> public.app_today() -----------
create or replace function public.regenerate_lease_reminders(p_lease_id uuid)
 returns void
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_owner   uuid;
  v_lease   leases%rowtype;
  kd        record;
  intervals int[] := array[30, 14, 7];
  labels    text[] := array['1_month', '2_weeks', '1_week'];
  i         int;
  channel   text;
begin
  select * into v_lease from leases where id = p_lease_id;
  if not found then
    return;  -- lease deleted; FK cascade already removed its key_dates/reminders
  end if;
  v_owner := v_lease.owner_id;

  -- Rebuild from scratch for this lease (cascade clears dependent reminders).
  delete from key_dates where lease_id = p_lease_id;

  -- Termination
  if v_lease.lease_termination_date is not null then
    insert into key_dates (owner_id, lease_id, date_type, event_date, description)
    values (v_owner, p_lease_id, 'termination', v_lease.lease_termination_date,
            'Lease termination for ' || v_lease.tenant_name);
  end if;

  -- Escalations
  insert into key_dates (owner_id, lease_id, date_type, event_date, description)
  select v_owner, p_lease_id, 'escalation', e.effective_date,
         'Rent escalation for ' || v_lease.tenant_name
    from rent_escalations e
   where e.lease_id = p_lease_id;

  -- Renewal notice deadlines
  insert into key_dates (owner_id, lease_id, date_type, event_date, description)
  select v_owner, p_lease_id, 'renewal_notice', r.notice_by_date,
         'Renewal notice deadline for ' || v_lease.tenant_name
    from renewal_options r
   where r.lease_id = p_lease_id and r.notice_by_date is not null;

  -- For each key date, create reminders at 1mo/2wk/1wk on both channels,
  -- skipping any that would already be in the past.
  for kd in select * from key_dates where lease_id = p_lease_id loop
    for i in 1 .. array_length(intervals, 1) loop
      foreach channel in array array['email', 'in_app'] loop
        if (kd.event_date - intervals[i]) >= public.app_today() then
          insert into reminders
            (owner_id, key_date_id, lease_id, remind_on, interval_label, channel, status)
          values
            (v_owner, kd.id, p_lease_id, kd.event_date - intervals[i], labels[i], channel, 'pending');
        end if;
      end loop;
    end loop;
  end loop;
end;
$function$;
