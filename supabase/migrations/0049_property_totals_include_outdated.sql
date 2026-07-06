-- 0049_property_totals_include_outdated.sql
-- Make the Overview + property Financials page count an "outdated / needs-extension"
-- tenant (leases.is_active = false) as OCCUPIED — matching what the Leases page shows.
--
-- The Leases page sums EVERY lease's square footage, so an expired-but-not-removed
-- tenant still counts as occupied (its space isn't "available"). But v_property_totals
-- (0044) computed leased SF / vacant / occupancy / revenue from `where is_active` only,
-- so that tenant's space read as vacant and its rent dropped from the rent roll — the
-- Overview and property page disagreed with the Leases page. George's call: an outdated
-- tenant counts FULLY (space + rent) until he removes it himself.
--
-- This recreates v_property_totals identical to 0044 EXCEPT:
--   • new `occupied` CTE = ALL leases → drives total_sf / building_sf fallback /
--     vacant_sf / occupancy (the physical-occupancy display columns).
--   • total_revenue / noi no longer filter is_active → an outdated lease's rent counts
--     (effective_rent falls back to the lease's base_rent).
--   • the periods CTE's leases branch no longer filters is_active, so a property with
--     only outdated leases still produces year rows.
--
-- BILLING IS UNCHANGED: the `leased` (active-only) CTE still feeds resp_sf and the
-- tax_psf / cam_psf / roof denominators, so the summary's $/SF rate cards keep matching
-- the per-tenant bills (v_tenant_shares, 0042). Non-destructive create-or-replace; same
-- column names/types/order; security_invoker re-asserted so RLS still applies.

create or replace view v_property_totals as
with leased as (            -- ACTIVE leases only — billing/roof denominators (unchanged from 0044)
  select property_id,
         coalesce(sum(square_footage), 0) as total_sf,
         coalesce(sum(square_footage) filter (where roof_responsible), 0) as resp_sf
  from leases where is_active group by property_id
),
occupied as (               -- ALL leases (incl. outdated) — physical occupancy, matches the Leases page
  select property_id,
         coalesce(sum(square_footage), 0) as total_sf
  from leases group by property_id
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
)
select
  p.id                                              as property_id,
  pr.year,
  coalesce(os.total_sf, 0)                          as total_sf,
  coalesce(p.building_sf, os.total_sf, 0)           as building_sf,
  greatest(0, coalesce(p.building_sf, os.total_sf, 0) - coalesce(os.total_sf, 0)) as vacant_sf,
  case when coalesce(p.building_sf, os.total_sf, 0) > 0
       then coalesce(os.total_sf, 0) / coalesce(p.building_sf, os.total_sf, 0) end as occupancy,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id), 0) as total_revenue,
  coalesce(er.taxes_total, 0)                       as taxes_total,
  coalesce(er.cam_total, 0)                         as cam_total,
  coalesce(er.roof_total, 0)                        as roof_total,
  (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as total_expenses,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id), 0)
    - (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as noi,
  -- Tax/CAM per SF of the WHOLE building (matches v_tenant_shares); falls back to ACTIVE leased SF.
  case when coalesce(nullif(p.building_sf, 0), ls.total_sf) > 0
       then coalesce(er.taxes_total, 0) / coalesce(nullif(p.building_sf, 0), ls.total_sf) end as tax_psf,
  case when coalesce(nullif(p.building_sf, 0), ls.total_sf) > 0
       then coalesce(er.cam_total, 0) / coalesce(nullif(p.building_sf, 0), ls.total_sf) end   as cam_psf,
  -- Raw roof rate left leased-based (not used for billing), unchanged from 0044.
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
left join leased ls on ls.property_id = p.id
left join occupied os on os.property_id = p.id;

alter view v_property_totals set (security_invoker = on);
