-- Property Management App — initial schema
-- Hierarchy: corporations -> properties -> leases (a "tenant" = one lease)
-- Page 2 financials are COMPUTED from lease data via views; never duplicated.

-- ---------------------------------------------------------------------------
-- Helper: updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Core hierarchy
-- ---------------------------------------------------------------------------
create table corporations (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table properties (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  corporation_id  uuid not null references corporations (id) on delete cascade,
  name            text not null,
  address         text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on properties (corporation_id);

create table lease_files (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  storage_path       text not null,
  original_filename  text,
  extraction_raw     jsonb,             -- raw Claude JSON for audit / re-review
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table leases (
  id                       uuid primary key default gen_random_uuid(),
  owner_id                 uuid not null references auth.users (id) on delete cascade,
  property_id              uuid not null references properties (id) on delete cascade,
  tenant_name              text not null,
  square_footage           numeric,
  base_rent                numeric,             -- initial base rent (annual)
  lease_start              date,
  lease_termination_date   date,
  lease_terms              text,
  share_override_pct       numeric,             -- null => pro-rata by SF (flagged assumption)
  source                   text not null default 'manual'
                             check (source in ('manual', 'ai_extracted')),
  extraction_status        text not null default 'reviewed'
                             check (extraction_status in ('pending', 'reviewed')),
  lease_file_id            uuid references lease_files (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index on leases (property_id);

create table rent_escalations (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  lease_id         uuid not null references leases (id) on delete cascade,
  effective_date   date not null,
  new_base_rent    numeric not null,            -- computed by code (% or fixed step applied to prior rent)
  escalation_type  text not null default 'manual'
                     check (escalation_type in ('fixed', 'percent', 'cpi', 'manual')),
  escalation_value numeric,                      -- the step ($) or percent
  status           text not null default 'scheduled'
                     check (status in ('scheduled', 'applied')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index on rent_escalations (lease_id, effective_date);

create table renewal_options (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  lease_id        uuid not null references leases (id) on delete cascade,
  option_label    text,
  notice_by_date  date,
  term_months     int,
  new_rent        numeric,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index on renewal_options (lease_id);

-- ---------------------------------------------------------------------------
-- Financials (Page 2), keyed by year
-- ---------------------------------------------------------------------------
create table expense_records (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  property_id   uuid not null references properties (id) on delete cascade,
  year          int not null,
  taxes_total   numeric not null default 0,
  cam_total     numeric not null default 0,
  roof_total    numeric not null default 0,      -- SEPARATE, excluded from PSF
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (property_id, year)
);

create table financial_snapshots (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  property_id     uuid not null references properties (id) on delete cascade,
  year            int not null,
  total_revenue   numeric,
  taxes_total     numeric,
  cam_total       numeric,
  roof_total      numeric,
  total_sf        numeric,
  tax_psf         numeric,
  cam_psf         numeric,
  breakdown       jsonb,                          -- per-tenant computed amounts at snapshot time
  snapshot_at     timestamptz not null default now(),
  unique (property_id, year)
);

-- ---------------------------------------------------------------------------
-- Notifications
-- ---------------------------------------------------------------------------
create table key_dates (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  lease_id     uuid not null references leases (id) on delete cascade,
  date_type    text not null check (date_type in ('escalation', 'termination', 'renewal_notice')),
  event_date   date not null,
  description  text,
  created_at   timestamptz not null default now()
);
create index on key_dates (event_date);

create table reminders (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  key_date_id    uuid not null references key_dates (id) on delete cascade,
  lease_id       uuid not null references leases (id) on delete cascade,
  remind_on      date not null,
  interval_label text not null check (interval_label in ('1_month', '2_weeks', '1_week')),
  channel        text not null check (channel in ('email', 'in_app')),
  status         text not null default 'pending' check (status in ('pending', 'sent', 'dismissed')),
  sent_at        timestamptz,
  created_at     timestamptz not null default now()
);
create index on reminders (remind_on, status);

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  reminder_id  uuid references reminders (id) on delete set null,
  lease_id     uuid references leases (id) on delete set null,
  title        text not null,
  body         text,
  read         boolean not null default false,
  created_at   timestamptz not null default now()
);
create index on notifications (owner_id, read);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'corporations','properties','lease_files','leases','rent_escalations',
    'renewal_options','expense_records'
  ] loop
    execute format(
      'create trigger trg_%1$s_updated before update on %1$s
       for each row execute function set_updated_at();', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Computed views (the math lives here — never the API)
-- effective_rent(year): latest APPLIED escalation with effective_date <= Dec 31 of year,
-- else the lease's base_rent.
-- ---------------------------------------------------------------------------
create or replace function effective_rent(p_lease_id uuid, p_year int)
returns numeric language sql stable as $$
  select coalesce(
    (select e.new_base_rent
       from rent_escalations e
      where e.lease_id = p_lease_id
        and e.status = 'applied'
        and e.effective_date <= make_date(p_year, 12, 31)
      order by e.effective_date desc
      limit 1),
    (select l.base_rent from leases l where l.id = p_lease_id)
  );
$$;

-- Per property + year: total SF, total revenue, and PSF rates (roof excluded).
create or replace view v_property_totals as
select
  p.id                                              as property_id,
  er.year,
  coalesce(sum(l.square_footage), 0)                as total_sf,
  coalesce(sum(effective_rent(l.id, er.year)), 0)   as total_revenue,
  er.taxes_total,
  er.cam_total,
  er.roof_total,
  case when coalesce(sum(l.square_footage),0) > 0
       then er.taxes_total / sum(l.square_footage) end as tax_psf,
  case when coalesce(sum(l.square_footage),0) > 0
       then er.cam_total / sum(l.square_footage)   end as cam_psf
from properties p
join expense_records er on er.property_id = p.id
left join leases l on l.property_id = p.id
group by p.id, er.year, er.taxes_total, er.cam_total, er.roof_total;

-- Per lease (tenant) + year: share %, tax/CAM dollars and PSF.
create or replace view v_tenant_shares as
select
  l.id                                          as lease_id,
  l.property_id,
  l.tenant_name,
  er.year,
  l.square_footage,
  effective_rent(l.id, er.year)                 as base_rent,
  coalesce(l.share_override_pct,
    case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) as share_pct,
  coalesce(l.share_override_pct,
    case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * er.taxes_total as tax_amount,
  coalesce(l.share_override_pct,
    case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * er.cam_total   as cam_amount
from leases l
join expense_records er on er.property_id = l.property_id
join (select property_id, coalesce(sum(square_footage),0) total_sf
        from leases group by property_id) pt on pt.property_id = l.property_id;

-- ---------------------------------------------------------------------------
-- Row Level Security: every table is owner-scoped
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'corporations','properties','lease_files','leases','rent_escalations',
    'renewal_options','expense_records','financial_snapshots','key_dates',
    'reminders','notifications'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy owner_all on %I for all
         using (owner_id = auth.uid())
         with check (owner_id = auth.uid());', t);
  end loop;
end;
$$;
