-- 0058_holdover_shares_address_sort.sql
-- Three additive, non-destructive changes:
--   1) leases.premises_address — the street address of the leased unit (AI-extracted),
--      used for the new Leases-page address sort. Purely a new nullable column.
--   2) user_preferences.lease_sort — per-account persisted Leases-page sort choice
--      (mode/direction + a per-property manual drag order). New nullable jsonb.
--   3) v_tenant_shares recreated to INCLUDE holdover / outdated tenants (is_active=false)
--      so they still appear on the monthly rent roll and keep billing until the landlord
--      removes them — matching the standing rule that an outdated tenant counts fully
--      (space + rent) until George removes it. Same as 0042 EXCEPT the `where l.is_active`
--      filter is dropped from the body and the `periods` CTE; three columns are appended
--      (is_active, lease_termination_date, premises_address). The fallback-denominator
--      subquery `pt` stays active-only, so no existing tenant's CAM/tax/roof bill changes.

-- 1) new columns -------------------------------------------------------------
alter table public.leases add column if not exists premises_address text;
alter table public.user_preferences add column if not exists lease_sort jsonb;

-- 3) v_tenant_shares — include outdated/holdover leases -----------------------
-- create-or-replace can only APPEND columns, so columns 1-15 keep the exact 0042
-- order (incl. the now-ignored tenant_email_2) and the three new ones are appended.
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
  l.premises_address
from leases l
join periods pr on pr.property_id = l.property_id
join properties p on p.id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
-- left join (was an inner join in 0042): a property whose leases are ALL outdated has
-- no active-SF row here, but its holdover tenants must still surface on the rent roll.
-- pt.total_sf is only the fallback denominator when building_sf is unset, so this never
-- changes an existing active tenant's bill (they always had a pt row).
left join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id;
alter view v_tenant_shares set (security_invoker = on);
