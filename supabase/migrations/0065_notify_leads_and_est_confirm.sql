-- 0065 — custom notification lead times + carried-over estimate marker.
--
-- Three additive columns and three function refreshes, all non-destructive:
--
--   1. user_preferences.notify_lead_times jsonb — per-owner "notify me N days
--      ahead" map, keyed by notification type ({ lease_end: 183, contract: 90 }).
--      null / a missing key = the app default, so an untouched account is unchanged.
--   2. leases.notify_lease_end_days int — a per-lease override for the lease-ending
--      reminder only (George: "thats the main variable one, everything else should
--      be consistent"). null = use the general setting.
--   3. leases.est_confirmed_year int — the last fiscal year for which the owner
--      saved/confirmed the CAM & tax estimate. Drives the "carried over from last
--      year — review and re-save" note on the Financials per-tenant breakdown.
--
-- v_tenant_shares is rebuilt to surface est_confirmed_year (append-only, so the
-- 1-22 columns keep their 0061 order). The two cron functions gain an OPTIONAL
-- custom early reminder / renewal-prompt lead read from notify_lead_times — they
-- behave BYTE-IDENTICALLY when the map is null or lacks the key (defaults preserve
-- today's 30/14/7 email cadence + 6-month renewal prompt). A new
-- regenerate_owner_reminders() RPC lets the Settings page rebuild the caller's
-- reminder rows immediately after saving a lead, instead of waiting for the nightly
-- cron.

-- 1) Additive columns -------------------------------------------------------------
alter table user_preferences add column if not exists notify_lead_times jsonb;
alter table leases add column if not exists notify_lease_end_days int;
alter table leases add column if not exists est_confirmed_year int;

-- 1b) Widen the reminders.interval_label CHECK so the new 'custom_lead' reminders can
-- be inserted. The original constraint (0001, inline/unnamed → Postgres-named
-- reminders_interval_label_check) only allowed 1_month/2_weeks/1_week. Without this,
-- regenerate_lease_reminders' custom-lead insert would violate the constraint — and
-- because that function also runs from the leases/escalations/renewals triggers (0002),
-- a plain lease edit would fail for any owner who set a custom lead. Additive: adding a
-- value to an IN-list check never rejects existing rows.
alter table reminders drop constraint if exists reminders_interval_label_check;
alter table reminders add constraint reminders_interval_label_check
  check (interval_label in ('1_month', '2_weeks', '1_week', 'custom_lead'));

-- 2) v_tenant_shares — append est_confirmed_year (columns 1-22 unchanged from 0061)
create or replace view v_tenant_shares as
with periods as (
  select property_id, year from expense_records
  union
  select distinct l.property_id, gs.year
  from leases l
  cross join generate_series(
    extract(year from now())::int - 6,
    extract(year from now())::int + 1
  ) as gs(year)
)
select
  l.id            as lease_id,
  l.property_id,
  l.tenant_name,
  l.tenant_email,
  l.tenant_contact_name,
  pr.year,
  l.square_footage,
  l.roof_responsible,
  effective_rent(l.id, pr.year) as base_rent,
  coalesce(l.share_override_pct, case when coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf) end) as share_pct,
  coalesce(l.share_override_pct, case when coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf) end) * coalesce(er.taxes_total, 0) as tax_amount,
  coalesce(l.share_override_pct, case when coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf) end) * coalesce(er.cam_total, 0)   as cam_amount,
  case when l.roof_responsible and coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then coalesce(er.roof_total, 0) * (l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf)) else 0 end as roof_amt,
  l.tenant_email_2,
  abatement_credit(l.id, pr.year) as abatement_amount,
  l.is_active,
  l.lease_termination_date,
  l.premises_address,
  l.est_cam_annual,
  l.est_tax_annual,
  l.est_roof_annual,
  l.lease_start,
  l.est_confirmed_year
from leases l
join periods pr on pr.property_id = l.property_id
join properties p on p.id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
left join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id;
alter view v_tenant_shares set (security_invoker = on);

-- 3) regenerate_lease_reminders — keep 30/14/7 exactly; ADD one optional earlier
--    email/in-app reminder when the owner set a custom lead > 30 days for that date
--    type. When notify_lead_times is null / the key is absent, nothing extra is
--    inserted (byte-identical to 0051). Termination honors the per-lease override.
create or replace function public.regenerate_lease_reminders(p_lease_id uuid)
 returns void
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_owner   uuid;
  v_lease   leases%rowtype;
  v_leads   jsonb;
  kd        record;
  intervals int[] := array[30, 14, 7];
  labels    text[] := array['1_month', '2_weeks', '1_week'];
  i         int;
  channel   text;
  v_lead    int;
begin
  select * into v_lease from leases where id = p_lease_id;
  if not found then
    return;  -- lease deleted; FK cascade already removed its key_dates/reminders
  end if;
  v_owner := v_lease.owner_id;
  select notify_lead_times into v_leads from user_preferences where user_id = v_owner;

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

    -- Optional custom early heads-up: only when the owner explicitly set a lead for
    -- this notification type AND it is earlier than the built-in 1-month reminder.
    -- Termination prefers the per-lease override. A null map / absent key → v_lead
    -- is null → nothing added (unchanged behavior).
    v_lead := case kd.date_type
      when 'termination'    then coalesce(v_lease.notify_lease_end_days, (v_leads->>'lease_end')::int)
      when 'escalation'     then (v_leads->>'escalation')::int
      when 'renewal_notice' then (v_leads->>'renewal')::int
      else null end;
    if v_lead is not null and v_lead > 30 and (kd.event_date - v_lead) >= public.app_today() then
      foreach channel in array array['email', 'in_app'] loop
        insert into reminders
          (owner_id, key_date_id, lease_id, remind_on, interval_label, channel, status)
        values
          (v_owner, kd.id, p_lease_id, kd.event_date - v_lead, 'custom_lead', channel, 'pending');
      end loop;
    end if;
  end loop;
end;
$function$;

-- 4) apply_due_renewals — same as 0051, but the "prompt opens" lead defaults to the
--    owner's custom renewal lead (in days) when set, else ~6 months (183d ≈ the prior
--    hard-coded 6-month interval). The notice-by-date path is unchanged.
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
  v_lead int;
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

    -- a bit before the deadline: notice-by date if stated, else the owner's renewal
    -- lead (default ~6 months) before term end.
    v_lead := coalesce(
      (select (notify_lead_times->>'renewal')::int from public.user_preferences where user_id = l.owner_id),
      183);
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - (v_lead || ' days')::interval)::date);
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

-- 5) regenerate_owner_reminders — rebuild every reminder row for the CALLING owner's
--    leases (SECURITY INVOKER, so RLS scopes it to their own rows). The Notifications
--    settings page calls this right after saving a lead, so a changed lead takes
--    effect immediately instead of at the next nightly cron.
create or replace function public.regenerate_owner_reminders()
 returns void
 language plpgsql
 security invoker
 set search_path to 'public'
as $function$
declare
  v_lease_id uuid;
begin
  for v_lease_id in select id from leases where owner_id = auth.uid() loop
    perform public.regenerate_lease_reminders(v_lease_id);
  end loop;
end;
$function$;

grant execute on function public.regenerate_owner_reminders() to authenticated;
