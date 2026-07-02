-- 0041_rent_abatement.sql
-- Rent abatement (free / reduced rent periods). A lease or addendum can grant the
-- tenant a stretch of free or reduced BASE rent (e.g. "months 1-8 free"). Until now
-- the app had no way to store or reflect it — a $0 period couldn't even be recorded as
-- a rent step (new_base_rent is NOT NULL and the rent math discards $0). This adds a
-- first-class abatement window per lease, nets it out of the invoice/AR figures, and
-- keeps the base rent itself untouched.
--
-- Base-rent-only by design: CAM / taxes / roof still accrue during an abatement (the
-- standard reading of a "rent abatement"). Additive and safe to run on the live project.

-- ---------------------------------------------------------------------------
-- 1) rent_abatements — one window per grant, owner-scoped like rent_escalations.
--    kind: 'free' ($0 base), 'percent' (value% off base), 'amount' (reduced fixed
--    monthly base of `value` dollars). addendum_id ties a window to the rider that
--    introduced it (null for a window read off the original lease or entered by hand).
-- ---------------------------------------------------------------------------
create table if not exists public.rent_abatements (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  lease_id     uuid not null references public.leases (id) on delete cascade,
  addendum_id  uuid references public.lease_addendums (id) on delete set null,
  start_date   date not null,
  end_date     date not null,
  kind         text not null default 'free' check (kind in ('free', 'percent', 'amount')),
  value        numeric,                          -- percent (kind='percent') or reduced $/mo (kind='amount'); null for 'free'
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint ck_abatement_dates check (end_date >= start_date),
  constraint ck_abatement_value check (value is null or (value >= 0 and value < 1e9))
);
create index if not exists rent_abatements_lease_idx on public.rent_abatements (lease_id, start_date);

do $$ begin
  create trigger trg_rent_abatements_updated before update on public.rent_abatements
    for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

alter table public.rent_abatements enable row level security;
do $$ begin
  create policy owner_all on public.rent_abatements for all
    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2) abatement_credit(lease, year): the total BASE $ abated within a calendar year.
--    Walks the 12 months; for each month covered by a window, credits the strongest
--    (largest) reduction. Mirrors src/lib/abatement.js exactly. Capped at the year's
--    base rent (can't abate more than there is).
-- ---------------------------------------------------------------------------
create or replace function abatement_credit(p_lease_id uuid, p_year int)
returns numeric language sql stable as $$
  with base as (select effective_rent(p_lease_id, p_year) as annual),
  months as (
    select gs as m,
           make_date(p_year, gs, 1)                                as mstart,
           (make_date(p_year, gs, 1) + interval '1 month - 1 day')::date as mend
    from generate_series(1, 12) gs
  ),
  covered as (
    select (
      select case a.kind
               when 'free'    then (select annual from base) / 12.0
               when 'percent' then (select annual from base) / 12.0 * least(100, greatest(0, coalesce(a.value, 0))) / 100.0
               when 'amount'  then greatest(0, (select annual from base) / 12.0 - greatest(0, coalesce(a.value, 0)))
               else 0 end
      from public.rent_abatements a
      where a.lease_id = p_lease_id
        and a.start_date <= m.mend
        and a.end_date   >= m.mstart
      order by (case a.kind
               when 'free'    then (select annual from base) / 12.0
               when 'percent' then (select annual from base) / 12.0 * least(100, greatest(0, coalesce(a.value, 0))) / 100.0
               when 'amount'  then greatest(0, (select annual from base) / 12.0 - greatest(0, coalesce(a.value, 0)))
               else 0 end) desc
      limit 1
    ) as credit
    from months m
  )
  select least(
    coalesce(round(sum(credit)::numeric, 2), 0),
    coalesce((select annual from base), 0)
  )
  from covered;
$$;

-- ---------------------------------------------------------------------------
-- 3) Surface the year's abatement on v_tenant_shares so invoices / AR / the monthly
--    tracker net it out. Body mirrors the latest definition (0033); abatement_amount is
--    APPENDED at the end so CREATE OR REPLACE accepts it, and security_invoker is
--    preserved so RLS on the base tables still applies through the view.
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
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) as share_pct,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * coalesce(er.taxes_total, 0) as tax_amount,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * coalesce(er.cam_total, 0)   as cam_amount,
  case when l.roof_responsible and pt.total_sf > 0 then coalesce(er.roof_total, 0) * (l.square_footage / pt.total_sf) else 0 end as roof_amt,
  l.tenant_email_2,
  abatement_credit(l.id, pr.year) as abatement_amount
from leases l
join periods pr on pr.property_id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id
where l.is_active;
alter view v_tenant_shares set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- 4) Persist the abatement on each stored invoice so a snapshot bill stays correct.
--    total_amount = base + cam + tax + roof − abatement (written by the app).
-- ---------------------------------------------------------------------------
alter table public.invoices add column if not exists abatement_annual numeric not null default 0;
do $$ begin
  alter table public.invoices add constraint ck_inv_abatement check (abatement_annual >= 0);
exception when duplicate_object then null; end $$;
