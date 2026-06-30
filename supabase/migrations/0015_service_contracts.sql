-- 0015_service_contracts.sql
-- Property service contracts: the standing agreements behind common-area
-- maintenance (landscaping, snow removal, security, …). Each holds the vendor,
-- cost, and term, plus a cached plain-text copy of the contract for AI Q&A.
-- NOT year-scoped (unlike cam_line_items): a contract is a standing agreement.
create table if not exists service_contracts (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  property_id    uuid not null references properties (id) on delete cascade,
  name           text,                  -- what the landlord calls this contract
  service_type   text,                  -- 'landscaping' | 'snow_removal' | 'security' | 'other'
  vendor         text,                  -- counterparty (AI-extracted; editable)
  amount         numeric,
  frequency      text,                  -- 'annual' | 'monthly' | 'one-time'
  start_date     date,
  end_date       date,
  contract_text  text,                  -- cached document for Q&A
  storage_path   text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists service_contracts_property_idx on service_contracts (property_id);

create trigger trg_service_contracts_updated
  before update on service_contracts
  for each row execute function set_updated_at();

alter table service_contracts enable row level security;
create policy owner_all on service_contracts for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
