-- 0073 — gross leases: a flat rent with CAM & taxes INCLUDED, not billed on top.
--
-- George, 2026-07-30: "There needs to be a gross lease option button in each lease's
-- page in lease terms. The AI extractor should be able to read if a lease is gross or
-- triple net and toggle that but also make it manual. And if a lease is gross … to
-- calculate the actual CAM and tax being paid, it needs to take the difference, which
-- is gonna show what portion of CAM and tax they owe, and then subtract it by the
-- annual base rent … So for CardPop, if the actual was ten thousand … you would
-- subtract ten thousand from the forty two thousand to get thirty two thousand, and
-- then thirty two thousand per year would be the new base rent."
--
-- Every lease in Amlak has been billed net (base rent PLUS the tenant's pro-rata share
-- of taxes/CAM/roof). A gross tenant pays one flat figure that already includes those
-- expenses — so their share must be CARVED OUT of the rent, never added to it.
--
-- Two additive pieces, both non-destructive:
--
--   1. leases.lease_type text check (in ('net','gross')) — nullable. null = net, so
--      every existing row behaves exactly as it does today. The lease page's toggle
--      and the AI analyst's expense_recovery verdict both write it.
--   2. v_tenant_shares rebuilt to surface lease_type (APPEND-ONLY as column 24, so
--      columns 1-23 keep their 0065 order — create-or-replace cannot reorder).
--
-- The share arithmetic is DELIBERATELY UNCHANGED: cam_amount / tax_amount / roof_amt
-- still compute the gross tenant's pro-rata share exactly as before. That share IS
-- their CAM & tax — the carve happens in one shared JS/TS helper (billedComponents),
-- which subtracts it from the flat rent rather than adding it. Because the property
-- genuinely recovers a gross tenant's share (out of the rent instead of on top of it),
-- the vacancy tie-out on the per-tenant breakdown keeps balancing with no view change,
-- and no OTHER tenant re-prices.
--
-- create_lease_tx needs no change: it uses jsonb_populate_record (0053), so the new
-- column flows through the import path automatically.

-- 1) The column ---------------------------------------------------------------------
alter table leases add column if not exists lease_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leases_lease_type_check'
  ) then
    alter table leases add constraint leases_lease_type_check
      check (lease_type is null or lease_type in ('net', 'gross'));
  end if;
end $$;

comment on column leases.lease_type is
  'Expense-recovery structure: ''net'' (tenant reimburses its share on top of rent) or ''gross'' (flat rent INCLUDES taxes/CAM — the share is carved out of it, never added). null = net.';

-- 2) v_tenant_shares — append lease_type (columns 1-23 byte-identical to 0065) -------
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
  l.premises_address,
  l.est_cam_annual,
  l.est_tax_annual,
  l.est_roof_annual,
  l.lease_start,
  l.est_confirmed_year,
  l.lease_type
from leases l
join periods pr on pr.property_id = l.property_id
join properties p on p.id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
left join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id;
alter view v_tenant_shares set (security_invoker = on);
