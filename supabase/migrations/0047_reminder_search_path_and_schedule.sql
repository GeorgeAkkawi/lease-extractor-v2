-- 0047_reminder_search_path_and_schedule.sql
-- Three notification-pipeline repairs (all additive / non-destructive):
--
--   A) Pin search_path = public on the three 0002 reminder trigger functions.
--      They were created with NO search_path, so they inherit the caller's. The
--      nightly cron apply_due_escalations() runs SECURITY DEFINER with
--      `search_path = ''`; when it updates rent_escalations it fires the
--      `escalations_reminders` trigger → trg_child_reminders() → the unqualified
--      regenerate_lease_reminders() call (and its unqualified table names) can't
--      resolve under the empty path, so the whole nightly job errors out and no
--      due escalation is ever applied. Pinning search_path = public makes these
--      SECURITY INVOKER functions resolve their own objects regardless of caller.
--
--   B) Give SQL apply_due_escalations() the same term-end gate the JS has: a step
--      dated on/after the lease's committed termination date belongs to an
--      un-exercised renewal option and must stay `scheduled` until the renewal is
--      confirmed (which extends the term). Without the gate the nightly cron would
--      silently jump a lapsed lease to an option rent nobody exercised. Mirrors
--      api.js applyDueEscalations (String(effective_date) >= termination → skip).
--
--   C) Schedule the `send-reminders` edge function daily (it was never scheduled —
--      only apply-due-lease-changes + daily-health-check exist). Uses the same Vault
--      secrets + x-cron-secret pattern as 0029's health-check. The function itself
--      refuses to run unless CRON_SECRET is set, and only ever emails the OWNER.

-- ===========================================================================
-- A) Reminder trigger functions — identical bodies to 0002, search_path pinned.
-- ===========================================================================
create or replace function public.regenerate_lease_reminders(p_lease_id uuid)
returns void
language plpgsql
set search_path = public
as $$
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
        if (kd.event_date - intervals[i]) >= current_date then
          insert into reminders
            (owner_id, key_date_id, lease_id, remind_on, interval_label, channel, status)
          values
            (v_owner, kd.id, p_lease_id, kd.event_date - intervals[i], labels[i], channel, 'pending');
        end if;
      end loop;
    end loop;
  end loop;
end;
$$;

create or replace function public.trg_lease_reminders()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform regenerate_lease_reminders(coalesce(new.id, old.id));
  return coalesce(new, old);
end;
$$;

create or replace function public.trg_child_reminders()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform regenerate_lease_reminders(coalesce(new.lease_id, old.lease_id));
  return coalesce(new, old);
end;
$$;

-- ===========================================================================
-- B) apply_due_escalations() — same as 0022, plus the term-end gate.
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
    -- Alias the joined leases table `lse` (not `l`) to avoid colliding with the
    -- PL/pgSQL `l record` variable assigned later in the loop body.
    select esc.*
      from public.rent_escalations esc
      join public.leases lse on lse.id = esc.lease_id
     where esc.status = 'scheduled'
       and esc.effective_date <= current_date
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

-- Keep the hardened grants from 0022 (create-or-replace preserves them, but be explicit).
revoke all on function public.apply_due_escalations() from public, anon, authenticated;

-- ===========================================================================
-- C) Schedule the daily send-reminders run at 13:00 UTC. Project URL + cron
--    secret come from Vault (names created out-of-band in 0029), so no secret
--    value ever appears in source or in cron.job. Guarded unschedule first so
--    re-running the migration replaces cleanly.
-- ===========================================================================
create extension if not exists pg_net;

do $$ begin
  perform cron.unschedule('send-reminders-daily');
exception when others then null; -- no existing job → nothing to unschedule
end $$;

do $$ begin
  perform cron.schedule(
    'send-reminders-daily',
    '0 13 * * *',
    $cmd$
    select net.http_post(
      url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/send-reminders',
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
    $cmd$
  );
exception when undefined_function then
  raise notice 'pg_cron not enabled — schedule send-reminders-daily manually once it is.';
end $$;
