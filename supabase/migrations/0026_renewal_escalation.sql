-- 0026_renewal_escalation.sql
-- Renewal options can now carry an ANNUAL % increase (e.g. "5% annual increase in
-- base rent" during the option term). When the option is exercised, the engine sets
-- the first renewal-year rent and MATERIALIZES one rent escalation per remaining year
-- of the term — so a "5% annual increase, 5-year option" becomes 5 real, dated rent
-- steps that auto-apply on their anniversaries. Universal (every lease), not one-off.

alter table renewal_options
  add column if not exists annual_escalation_pct numeric
    check (annual_escalation_pct is null or (annual_escalation_pct >= 0 and annual_escalation_pct <= 100));

-- Re-create apply_due_renewals() (from 0022) with the first-year + materialization
-- logic added. Still mirrors the JS applyDueRenewals; still hardened.
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
  v_pct numeric;
  v_years int;
  v_y int;
  v_term date;
  v_start date;
  v_rent numeric;
  v_guard integer;
  v_count integer := 0;
begin
  for l in
    select * from public.leases
     where is_active
       and lease_termination_date is not null
       and lease_termination_date <= current_date
  loop
    select * into v_prop from public.properties where id = l.property_id;

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
      v_pct       := coalesce(r.annual_escalation_pct, 0);

      -- First renewal-year rent: an explicit new_rent wins; else apply the annual %
      -- to the prior rent; else carry the prior rent.
      if r.new_rent is not null then
        v_new_rent := r.new_rent;
      elsif v_pct > 0 then
        v_new_rent := round(v_old_rent * (1 + v_pct / 100.0), 2);
      else
        v_new_rent := v_old_rent;
      end if;

      insert into public.expired_leases (owner_id, property_id, tenant_name, sf, base_rent, lease_start, lease_end, status, note)
      values (l.owner_id, l.property_id, l.tenant_name, l.square_footage, v_old_rent, v_start, v_term,
              'Renewed', 'Auto-renewed (' || coalesce(r.option_label, 'renewal option') || ') — new term through ' || v_new_end);

      update public.leases
         set lease_start = v_new_start, lease_termination_date = v_new_end, base_rent = v_new_rent
       where id = l.id;

      update public.renewal_options set status = 'applied', applied_at = now() where id = r.id;

      -- Materialize the remaining annual step-ups within the option term as scheduled
      -- escalations (year 1 is the new base above; years 2..N each +pct%).
      if v_pct > 0 then
        v_years := floor(coalesce(r.term_months, 12) / 12.0)::int;
        for v_y in 1 .. greatest(v_years - 1, 0) loop
          insert into public.rent_escalations
            (owner_id, lease_id, effective_date, escalation_type, escalation_value, new_base_rent, status)
          values (
            l.owner_id, l.id,
            v_new_start + make_interval(months => v_y * 12),
            'percent', v_pct,
            round(v_new_rent * power(1 + v_pct / 100.0, v_y), 2),
            'scheduled'
          );
        end loop;
      end if;

      if v_new_start >= current_date - interval '31 days' then
        insert into public.notifications
          (owner_id, lease_id, property_id, corporation_id, kind, title, body, email_subject, email_body, read)
        values (
          l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'renewal_applied',
          'Lease renewed — ' || l.tenant_name,
          'Term extended to ' || v_new_end || ' · base rent now ' || to_char(v_new_rent, 'FM$999,999,999')
            || case when v_pct > 0 then ' · +' || v_pct || '%/yr scheduled' else '' end,
          'Lease renewal — ' || coalesce(v_prop.name, 'your space') || ' (effective ' || to_char(v_new_start, 'FMMonth FMDD, YYYY') || ')',
          'Dear ' || l.tenant_name || E',\n\nThis note confirms that your lease has renewed. The new term runs ' ||
            to_char(v_new_start, 'FMMonth FMDD, YYYY') || ' through ' || to_char(v_new_end, 'FMMonth FMDD, YYYY') ||
            '. Your new annual base rent is ' || to_char(v_new_rent, 'FM$999,999,999') ||
            E'. Please update your records and remit the new amount beginning with the renewed term.\n\nThank you,\nProperty Management',
          false
        );
      end if;

      v_start := v_new_start;
      v_term  := v_new_end;
      v_rent  := v_new_rent;
      v_count := v_count + 1;
    end loop;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.apply_due_renewals() from public, anon, authenticated;
