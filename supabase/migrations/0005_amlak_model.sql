-- Phase 2: financial depth — building size/vacancy/occupancy, NOI, per-tenant roof billing.

alter table properties add column if not exists building_sf numeric;
alter table leases add column if not exists roof_responsible boolean not null default false;
alter table leases add column if not exists ai_confidence jsonb; -- per-field {field: conf} (used in Phase 3)

-- ---------------------------------------------------------------------------
-- v_property_totals: add building_sf, vacant_sf, occupancy, total_expenses,
-- noi, roof_psf_rate, roof_recovered, roof_unrecovered.
-- PSF is computed on LEASED sf; occupancy uses building sf.
-- roof_recovered = roof × (responsible leased sf / total leased sf).
-- ---------------------------------------------------------------------------
-- drop + recreate (not CREATE OR REPLACE): this revision inserts new columns
-- (building_sf, vacant_sf, occupancy, ...) mid-list, which Postgres rejects on
-- replace. The view has no dependents, so a plain drop is safe.
drop view if exists v_property_totals;
create view v_property_totals as
with leased as (
  select property_id,
         coalesce(sum(square_footage), 0) as total_sf,
         coalesce(sum(square_footage) filter (where roof_responsible), 0) as resp_sf
  from leases group by property_id
)
select
  p.id                                              as property_id,
  er.year,
  coalesce(ls.total_sf, 0)                          as total_sf,
  coalesce(p.building_sf, ls.total_sf, 0)           as building_sf,
  greatest(0, coalesce(p.building_sf, ls.total_sf, 0) - coalesce(ls.total_sf, 0)) as vacant_sf,
  case when coalesce(p.building_sf, ls.total_sf, 0) > 0
       then coalesce(ls.total_sf, 0) / coalesce(p.building_sf, ls.total_sf, 0) end as occupancy,
  coalesce((select sum(effective_rent(l.id, er.year)) from leases l where l.property_id = p.id), 0) as total_revenue,
  er.taxes_total,
  er.cam_total,
  er.roof_total,
  (er.taxes_total + er.cam_total + er.roof_total)   as total_expenses,
  coalesce((select sum(effective_rent(l.id, er.year)) from leases l where l.property_id = p.id), 0)
    - (er.taxes_total + er.cam_total + er.roof_total) as noi,
  case when ls.total_sf > 0 then er.taxes_total / ls.total_sf end as tax_psf,
  case when ls.total_sf > 0 then er.cam_total / ls.total_sf end   as cam_psf,
  case when ls.total_sf > 0 then er.roof_total / ls.total_sf end  as roof_psf_rate,
  case when ls.total_sf > 0 then er.roof_total * (ls.resp_sf / ls.total_sf) else 0 end as roof_recovered,
  er.roof_total - (case when ls.total_sf > 0 then er.roof_total * (ls.resp_sf / ls.total_sf) else 0 end) as roof_unrecovered
from properties p
join expense_records er on er.property_id = p.id
left join leased ls on ls.property_id = p.id;

-- ---------------------------------------------------------------------------
-- v_tenant_shares: tax/CAM use the per-lease override share; roof uses the
-- pro-rata SF share (sf/total) when the lease is roof_responsible (per design).
-- ---------------------------------------------------------------------------
-- drop + recreate: roof_responsible is inserted mid-list (see note above).
drop view if exists v_tenant_shares;
create view v_tenant_shares as
select
  l.id            as lease_id,
  l.property_id,
  l.tenant_name,
  er.year,
  l.square_footage,
  l.roof_responsible,
  effective_rent(l.id, er.year) as base_rent,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) as share_pct,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * er.taxes_total as tax_amount,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * er.cam_total   as cam_amount,
  case when l.roof_responsible and pt.total_sf > 0 then er.roof_total * (l.square_footage / pt.total_sf) else 0 end as roof_amt
from leases l
join expense_records er on er.property_id = l.property_id
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases group by property_id) pt
  on pt.property_id = l.property_id;
