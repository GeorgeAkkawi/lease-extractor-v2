-- 0048_fix_apply_due_renewals_alias.sql
-- Follow-on to 0047. Once 0047 fixed the search_path crash, the nightly
-- apply_due_changes() got far enough to run apply_due_renewals() — which then
-- errored on its OWN latent bug:
--
--   ERROR 55000: record "l" is not assigned yet
--   in:  delete from public.notifications n using public.leases l where n.lease_id = l.id ...
--
-- The cleanup DELETE aliases public.leases as `l`, but `l` is also the PL/pgSQL
-- record variable for the main loop (declared, not yet assigned at the DELETE).
-- PL/pgSQL resolves `l.id` to the unassigned record variable → error, so the
-- renewals half of the nightly job never completed. Rename the DELETE's table
-- alias to `lz` (no collision). Function body is otherwise byte-identical to the
-- live 0022/0034/0036 version — still SECURITY DEFINER, search_path='',
-- everything schema-qualified. Non-destructive create-or-replace.

create or replace function public.apply_due_renewals()
returns integer
language plpgsql
security definer
set search_path = ''
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
  -- Alias leases `lz` (not `l`) to avoid colliding with the loop record variable.
  delete from public.notifications n
   using public.leases lz
   where n.lease_id = lz.id
     and n.kind = 'renewal_decision'
     and lz.lease_termination_date is not null
     and lz.lease_termination_date < current_date;

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

    -- a bit before the deadline: notice-by date if stated, else ~6 months before term end
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - interval '6 months')::date);
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
$function$;

revoke all on function public.apply_due_renewals() from public, anon, authenticated;
