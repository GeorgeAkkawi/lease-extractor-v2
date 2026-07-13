-- 0060_cam_tax_estimates.sql
-- Estimated CAM & tax billing + year-end reconciliation. Real-world model: the true
-- CAM is only known once the year closes, so during the year the tenant pays an agreed
-- ESTIMATE (typed per lease by the landlord); at year end the landlord reconciles the
-- estimate billed against the tenant's actual share — the tenant owes the shortfall,
-- or the landlord refunds the overage. Roof (always billed separately, only to
-- roof-responsible tenants) gets the identical estimate → reconcile treatment.
--
-- Four additive changes:
--   1) leases: three nullable estimate columns. Null = no estimate → that component
--      keeps billing from actuals exactly as today (fully backward compatible; a
--      landlord can enter only the CAM estimate and let the known tax bill actuals).
--   2) v_tenant_shares: recreated byte-identical to 0058 with the three estimate
--      columns APPENDED (create-or-replace can only append, so columns 1-18 keep
--      their exact 0058 order).
--   3) invoices.kind ('annual' | 'reconciliation'): a year-end reconciliation is its
--      own invoice for the same (lease, year), so the 0055 one-live-invoice unique
--      index is re-scoped per kind (constraint change only — no data touched; the
--      default backfills every existing row as 'annual').
--   4) cam_reconciliations: the owner-scoped record that a lease-year was reconciled —
--      the billed-estimate vs actual snapshot, the signed difference, and (when the
--      landlord owes the tenant) the refund open/settled state. tenant_owes links to
--      the reconciliation invoice, whose paid state AR already tracks.

-- 1) per-lease estimates -------------------------------------------------------
alter table public.leases add column if not exists est_cam_annual  numeric;
alter table public.leases add column if not exists est_tax_annual  numeric;
alter table public.leases add column if not exists est_roof_annual numeric;

-- 2) v_tenant_shares — append the estimate columns -----------------------------
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
  l.est_roof_annual
from leases l
join periods pr on pr.property_id = l.property_id
join properties p on p.id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
left join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id;
alter view v_tenant_shares set (security_invoker = on);

-- 3) invoices.kind + kind-scoped dedupe indexes --------------------------------
alter table public.invoices add column if not exists kind text not null default 'annual';
do $$ begin
  alter table public.invoices add constraint ck_inv_kind check (kind in ('annual', 'reconciliation'));
exception when duplicate_object then null; end $$;

-- New indexes FIRST (all existing rows are kind='annual', so the annual index is
-- exactly the old guarantee), then retire the un-scoped 0055 index it replaces.
create unique index if not exists invoices_one_live_annual_per_lease_year
  on public.invoices (lease_id, year) where status <> 'void' and kind = 'annual';
create unique index if not exists invoices_one_live_recon_per_lease_year
  on public.invoices (lease_id, year) where status <> 'void' and kind = 'reconciliation';
drop index if exists invoices_one_live_per_lease_year;

-- 4) cam_reconciliations -------------------------------------------------------
create table if not exists public.cam_reconciliations (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  lease_id     uuid not null references public.leases (id) on delete cascade,
  property_id  uuid not null references public.properties (id) on delete cascade,
  year         int  not null check (year between 1900 and 2200),
  -- what was billed during the year (the estimate snapshot) vs the true share
  est_cam      numeric not null default 0,
  est_tax      numeric not null default 0,
  est_roof     numeric not null default 0,
  actual_cam   numeric not null default 0,
  actual_tax   numeric not null default 0,
  actual_roof  numeric not null default 0,
  diff         numeric not null default 0,  -- actual − estimate; > 0 ⇒ tenant owes
  direction    text not null check (direction in ('tenant_owes', 'landlord_owes', 'even')),
  -- refund lifecycle (landlord_owes): open until the landlord marks it refunded.
  -- tenant_owes settles through the linked invoice's payments (derived, never stored).
  status       text not null default 'open' check (status in ('open', 'settled')),
  invoice_id   uuid references public.invoices (id) on delete set null,
  settled_at   date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One reconciliation per lease-year (the reconcile helper is idempotent on this).
create unique index if not exists cam_reconciliations_lease_year_idx
  on public.cam_reconciliations (lease_id, year);
create index if not exists cam_reconciliations_prop_idx
  on public.cam_reconciliations (property_id, year);

drop trigger if exists trg_cam_reconciliations_updated on public.cam_reconciliations;
create trigger trg_cam_reconciliations_updated
  before update on public.cam_reconciliations
  for each row execute function set_updated_at();

alter table public.cam_reconciliations enable row level security;

do $$ begin
  create policy owner_all on public.cam_reconciliations for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Same aal2 enforcement as every other owner-scoped table (0052) — dormant until
-- the user enrolls a 2FA factor.
do $$ begin
  create policy require_aal2 on public.cam_reconciliations
    as restrictive to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null; end $$;
