-- ---------------------------------------------------------------------------
-- Financials were gated on expenses: v_property_totals and v_tenant_shares both
-- INNER-joined expense_records, so a property only produced a (property, year)
-- row once an expense record existed for that year. Result: a freshly-added
-- lease showed $0 revenue in Financials until the user also entered expenses.
--
-- Fix: build the (property, year) grid from expense_records UNION the fiscal-year
-- window the UI offers (currentYear-6 .. currentYear+1, matching YearSelector) for
-- any property that has leases, then LEFT JOIN expense_records (coalescing the
-- tax/CAM/roof totals to 0). Revenue (lease-derived) now shows with zero expenses.
-- ---------------------------------------------------------------------------

drop view if exists v_property_totals;
create view v_property_totals as
with leased as (
  select property_id,
         coalesce(sum(square_footage), 0) as total_sf,
         coalesce(sum(square_footage) filter (where roof_responsible), 0) as resp_sf
  from leases group by property_id
),
periods as (
  -- years that have an expense record (preserves historical/out-of-window years) …
  select property_id, year from expense_records
  union
  -- … plus every selectable fiscal year for any property that has leases, so a
  -- lease's revenue appears in Financials before any expenses are entered.
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
  coalesce(ls.total_sf, 0)                          as total_sf,
  coalesce(p.building_sf, ls.total_sf, 0)           as building_sf,
  greatest(0, coalesce(p.building_sf, ls.total_sf, 0) - coalesce(ls.total_sf, 0)) as vacant_sf,
  case when coalesce(p.building_sf, ls.total_sf, 0) > 0
       then coalesce(ls.total_sf, 0) / coalesce(p.building_sf, ls.total_sf, 0) end as occupancy,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id), 0) as total_revenue,
  coalesce(er.taxes_total, 0)                       as taxes_total,
  coalesce(er.cam_total, 0)                         as cam_total,
  coalesce(er.roof_total, 0)                        as roof_total,
  (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as total_expenses,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id), 0)
    - (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as noi,
  case when ls.total_sf > 0 then coalesce(er.taxes_total, 0) / ls.total_sf end as tax_psf,
  case when ls.total_sf > 0 then coalesce(er.cam_total, 0) / ls.total_sf end   as cam_psf,
  case when ls.total_sf > 0 then coalesce(er.roof_total, 0) / ls.total_sf end  as roof_psf_rate,
  case when ls.total_sf > 0 then coalesce(er.roof_total, 0) * (ls.resp_sf / ls.total_sf) else 0 end as roof_recovered,
  coalesce(er.roof_total, 0) - (case when ls.total_sf > 0 then coalesce(er.roof_total, 0) * (ls.resp_sf / ls.total_sf) else 0 end) as roof_unrecovered
from properties p
join periods pr on pr.property_id = p.id
left join expense_records er on er.property_id = p.id and er.year = pr.year
left join leased ls on ls.property_id = p.id;

-- Same de-gating for the per-tenant share table (mirrors 0008 columns).
drop view if exists v_tenant_shares;
create view v_tenant_shares as
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
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) as share_pct,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * coalesce(er.taxes_total, 0) as tax_amount,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * coalesce(er.cam_total, 0)   as cam_amount,
  case when l.roof_responsible and pt.total_sf > 0 then coalesce(er.roof_total, 0) * (l.square_footage / pt.total_sf) else 0 end as roof_amt
from leases l
join periods pr on pr.property_id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases group by property_id) pt
  on pt.property_id = l.property_id;
