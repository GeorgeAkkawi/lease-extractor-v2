-- Auto-generate key_dates + reminders from lease data.
-- Runs on any change to leases / rent_escalations / renewal_options so the
-- notification pipeline always reflects current lease terms.

create or replace function regenerate_lease_reminders(p_lease_id uuid)
returns void language plpgsql as $$
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

-- Trigger wrappers ----------------------------------------------------------
create or replace function trg_lease_reminders()
returns trigger language plpgsql as $$
begin
  perform regenerate_lease_reminders(coalesce(new.id, old.id));
  return coalesce(new, old);
end;
$$;

create or replace function trg_child_reminders()
returns trigger language plpgsql as $$
begin
  perform regenerate_lease_reminders(coalesce(new.lease_id, old.lease_id));
  return coalesce(new, old);
end;
$$;

create trigger leases_reminders
  after insert or update of lease_termination_date, tenant_name on leases
  for each row execute function trg_lease_reminders();

create trigger escalations_reminders
  after insert or update or delete on rent_escalations
  for each row execute function trg_child_reminders();

create trigger renewals_reminders
  after insert or update or delete on renewal_options
  for each row execute function trg_child_reminders();

-- Scheduling note: deploy the `send-reminders` Edge Function, then schedule it
-- daily with pg_cron (run once in the SQL editor, substituting your project ref
-- and a service-role key stored via Vault):
--
--   select cron.schedule(
--     'send-reminders-daily', '0 13 * * *',  -- 13:00 UTC daily
--     $$ select net.http_post(
--          url := 'https://YOUR-REF.functions.supabase.co/send-reminders',
--          headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret'))
--        ); $$
--   );
