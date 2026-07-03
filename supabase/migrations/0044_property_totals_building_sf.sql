-- 0044_property_totals_building_sf.sql
-- Follow-up to 0042: bill the SUMMARY "$/SF" rates off the WHOLE building's square
-- footage too, so they match what tenants are actually billed (v_tenant_shares).
--
-- 0042 switched v_tenant_shares (per-tenant bills + invoices) to divide tax/CAM/roof
-- by the building size, leaving the vacant share with the landlord. But the property
-- Financials summary cards read a SECOND view, v_property_totals, whose tax_psf /
-- cam_psf / roof_recovered still divided by LEASED SF — so the headline rate
-- contradicted the per-tenant breakdown below it.
--
-- This recreates v_property_totals identical to 0021 EXCEPT the three denominators,
-- which now use coalesce(nullif(building_sf,0), leased SF) — the same building-first
-- divisor as 0042. If no building size is entered yet, it falls back to leased SF, so
-- nothing breaks. Non-destructive create-or-replace; security_invoker re-asserted so
-- RLS on the base tables still applies through the view. No other column changes.

create or replace view v_property_totals as
with leased as (
  select property_id,
         coalesce(sum(square_footage), 0) as total_sf,
         coalesce(sum(square_footage) filter (where roof_responsible), 0) as resp_sf
  from leases where is_active group by property_id
),
periods as (
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
  p.id                                              as property_id,
  pr.year,
  coalesce(ls.total_sf, 0)                          as total_sf,
  coalesce(p.building_sf, ls.total_sf, 0)           as building_sf,
  greatest(0, coalesce(p.building_sf, ls.total_sf, 0) - coalesce(ls.total_sf, 0)) as vacant_sf,
  case when coalesce(p.building_sf, ls.total_sf, 0) > 0
       then coalesce(ls.total_sf, 0) / coalesce(p.building_sf, ls.total_sf, 0) end as occupancy,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id and l.is_active), 0) as total_revenue,
  coalesce(er.taxes_total, 0)                       as taxes_total,
  coalesce(er.cam_total, 0)                         as cam_total,
  coalesce(er.roof_total, 0)                        as roof_total,
  (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as total_expenses,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id and l.is_active), 0)
    - (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as noi,
  -- Tax/CAM per SF of the WHOLE building (matches v_tenant_shares); falls back to leased SF.
  case when coalesce(nullif(p.building_sf, 0), ls.total_sf) > 0
       then coalesce(er.taxes_total, 0) / coalesce(nullif(p.building_sf, 0), ls.total_sf) end as tax_psf,
  case when coalesce(nullif(p.building_sf, 0), ls.total_sf) > 0
       then coalesce(er.cam_total, 0) / coalesce(nullif(p.building_sf, 0), ls.total_sf) end   as cam_psf,
  -- Raw roof rate left leased-based (not used for billing), unchanged from 0021.
  case when ls.total_sf > 0 then coalesce(er.roof_total, 0) / ls.total_sf end  as roof_psf_rate,
  -- Roof "billed vs absorbed": recovered = roof-responsible SF over the building SF,
  -- so it equals the sum of roof_amt charged to tenants in v_tenant_shares (0042).
  case when coalesce(nullif(p.building_sf, 0), ls.total_sf) > 0
       then coalesce(er.roof_total, 0) * (ls.resp_sf / coalesce(nullif(p.building_sf, 0), ls.total_sf)) else 0 end as roof_recovered,
  coalesce(er.roof_total, 0) - (case when coalesce(nullif(p.building_sf, 0), ls.total_sf) > 0
       then coalesce(er.roof_total, 0) * (ls.resp_sf / coalesce(nullif(p.building_sf, 0), ls.total_sf)) else 0 end) as roof_unrecovered
from properties p
join periods pr on pr.property_id = p.id
left join expense_records er on er.property_id = p.id and er.year = pr.year
left join leased ls on ls.property_id = p.id;

alter view v_property_totals set (security_invoker = on);
