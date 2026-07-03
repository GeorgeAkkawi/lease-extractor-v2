-- 0042_sf_billing_contracts_6mo.sql
-- Three additive changes, all safe to run on the live project:
--   1) Bill CAM / property taxes / roof over the WHOLE building's square footage
--      (denominator = building_sf), so the cost of vacant space stays with the
--      landlord instead of being split across only the leased tenants.
--   2) Open the renewal-decision prompt 6 months before term end (was 3).
--   3) Give service contracts a yearly escalation % + a vendor email, and let a CAM
--      line item be owned by a contract (so it can be auto-created/refreshed each year).

-- ---------------------------------------------------------------------------
-- 1) v_tenant_shares — per-SF-of-the-building allocation.
--    Denominator = coalesce(building_sf, leased SF): if the landlord hasn't entered
--    the building size yet we fall back to today's leased-SF behaviour, so nothing
--    breaks before building_sf is set. A per-lease share_override_pct still wins.
--    Body mirrors 0041; only the denominator changes (a properties join is added).
--    security_invoker preserved so RLS on the base tables still applies through it.
-- ---------------------------------------------------------------------------
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
  where l.is_active
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
  abatement_credit(l.id, pr.year) as abatement_amount
from leases l
join periods pr on pr.property_id = l.property_id
join properties p on p.id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id
where l.is_active;
alter view v_tenant_shares set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- 2) apply_due_renewals() — open the decision prompt ~6 months before term end
--    (was 3). Mirrors the JS isRenewalDecisionDue. Otherwise identical to 0039
--    (prompt-only; never modifies a lease). Non-destructive create-or-replace.
-- ---------------------------------------------------------------------------
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
$$;

revoke all on function public.apply_due_renewals() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Service-contract escalations + a CAM line item that a contract can own.
--    escalation_pct: yearly increase on the contract fee (null/0 = flat).
--    vendor_email:   who to email a renewal notice to.
--    cam_line_items.contract_id: when set, the row is auto-managed by the contract
--    (created/refreshed each fiscal year at the escalated amount). Deleting the
--    contract removes its CAM rows; the unique index keeps one row per year.
-- ---------------------------------------------------------------------------
alter table public.service_contracts add column if not exists escalation_pct numeric;
alter table public.service_contracts add column if not exists vendor_email text;

alter table public.cam_line_items add column if not exists contract_id uuid references public.service_contracts (id) on delete cascade;
create unique index if not exists cam_line_items_contract_year_uidx
  on public.cam_line_items (contract_id, year) where contract_id is not null;
