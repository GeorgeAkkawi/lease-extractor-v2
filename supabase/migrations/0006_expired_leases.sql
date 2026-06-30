-- Phase 3: archive of prior leases (renewed / vacated / terminated), shown on the History page.
create table expired_leases (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  property_id   uuid not null references properties (id) on delete cascade,
  tenant_name   text not null,
  sf            numeric,
  base_rent     numeric,
  lease_start   date,
  lease_end     date,
  status        text not null default 'Vacated' check (status in ('Renewed', 'Vacated', 'Terminated')),
  note          text,
  created_at    timestamptz not null default now()
);
create index on expired_leases (property_id);

alter table expired_leases enable row level security;
create policy owner_all on expired_leases for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
