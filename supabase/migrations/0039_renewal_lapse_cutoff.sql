-- 0039_renewal_lapse_cutoff.sql
-- Stop prompting a renewal decision once the committed term has already ended: a pending
-- option whose term slot has passed lapsed unexercised, so there's nothing to decide.
-- Mirrors the JS isRenewalDecisionDue (which now returns false once term end < today).
-- Two changes vs 0036, both non-destructive: (1) the lease scan skips leases whose term
-- already ended, and (2) any stale 'renewal_decision' prompt left over from before the
-- term lapsed is cleared. Recreates the same prompt-only function body otherwise.
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
  v_years int;
  v_rent_label text;
  v_trigger date;
  v_count integer := 0;
begin
  -- Clear stale prompts for leases whose term has since ended (option lapsed).
  delete from public.notifications n
   using public.leases l
   where n.lease_id = l.id
     and n.kind = 'renewal_decision'
     and l.lease_termination_date is not null
     and l.lease_termination_date < current_date;

  for l in
    select * from public.leases
     where is_active
       and lease_termination_date is not null
       and lease_termination_date >= current_date   -- term not yet ended
  loop
    select * into r
      from public.renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    continue when not found;

    -- a bit before the deadline: notice-by date if stated, else ~3 months before term end
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - interval '3 months')::date);
    continue when current_date < v_trigger;

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
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.apply_due_renewals() from public, anon, authenticated;
