-- 0007_renewal_apply.sql
-- Automatic lease renewals + a clearable notification (with a tenant email).
-- In demo mode the equivalent runs in JS on app load (src/lib/api.js
-- applyDueRenewals); at go-live, schedule apply_due_renewals() with pg_cron.

-- Renewal options gain a lifecycle so each option is applied at most once.
alter table renewal_options
  add column if not exists status text not null default 'pending'
    check (status in ('pending', 'applied')),
  add column if not exists applied_at timestamptz;

-- Notifications can now carry a kind + a ready-to-send tenant email and the
-- corp/property context so the inbox can deep-link.
alter table notifications
  add column if not exists kind text not null default 'info',
  add column if not exists email_subject text,
  add column if not exists email_body text,
  add column if not exists property_id uuid references properties(id) on delete cascade,
  add column if not exists corporation_id uuid references corporations(id) on delete cascade;

-- Roll any lease whose term has ended and that still has a pending renewal
-- option into its new term: archive the prior term, extend dates, apply the new
-- rent, mark the option applied, and create a notification with a tenant email.
create or replace function apply_due_renewals()
returns integer
language plpgsql
security definer
as $$
declare
  l record;
  r record;
  v_new_start date;
  v_new_end date;
  v_old_rent numeric;
  v_new_rent numeric;
  v_prop record;
  v_count integer := 0;
begin
  for l in
    select * from leases
    where lease_termination_date is not null
      and lease_termination_date <= current_date
  loop
    select * into r
      from renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    if not found then
      continue;
    end if;

    select * into v_prop from properties where id = l.property_id;

    v_new_start := l.lease_termination_date;
    v_new_end   := l.lease_termination_date + make_interval(months => coalesce(r.term_months, 12));
    v_old_rent  := coalesce(l.base_rent, 0);
    v_new_rent  := coalesce(r.new_rent, v_old_rent);

    insert into expired_leases (owner_id, property_id, tenant_name, sf, base_rent, lease_start, lease_end, status, note)
    values (l.owner_id, l.property_id, l.tenant_name, l.square_footage, v_old_rent, l.lease_start, l.lease_termination_date,
            'Renewed', 'Auto-renewed (' || coalesce(r.option_label, 'renewal option') || ') — new term through ' || v_new_end);

    update leases
       set lease_start = v_new_start,
           lease_termination_date = v_new_end,
           base_rent = v_new_rent
     where id = l.id;

    update renewal_options set status = 'applied', applied_at = now() where id = r.id;

    insert into notifications (owner_id, lease_id, property_id, corporation_id, kind, title, body, email_subject, email_body, read)
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

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- At go-live, run daily (requires pg_cron):
--   select cron.schedule('apply-due-renewals', '0 6 * * *', $$select apply_due_renewals();$$);
