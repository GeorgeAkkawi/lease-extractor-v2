-- 0014_insurance_policies.sql
-- Insurance vault: the landlord's building policy (one per property) and each
-- tenant's policy (one per lease). Each holds a cached plain-text copy for the AI
-- assistant plus a few key-facts (insurer, coverage limit, expiry, additional
-- insured) auto-filled on upload and editable by hand.
create table if not exists insurance_policies (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users (id) on delete cascade,
  party              text not null check (party in ('landlord', 'tenant')),
  property_id        uuid references properties (id) on delete cascade,  -- set for landlord
  lease_id           uuid references leases (id) on delete cascade,      -- set for tenant
  insurer            text,
  coverage_amount    numeric,
  expiry_date        date,
  additional_insured boolean,
  policy_text        text,           -- cached document for Q&A
  storage_path       text,           -- optional uploaded file
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists insurance_policies_property_idx on insurance_policies (property_id);
create index if not exists insurance_policies_lease_idx on insurance_policies (lease_id);

create trigger trg_insurance_policies_updated
  before update on insurance_policies
  for each row execute function set_updated_at();

alter table insurance_policies enable row level security;
create policy owner_all on insurance_policies for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
