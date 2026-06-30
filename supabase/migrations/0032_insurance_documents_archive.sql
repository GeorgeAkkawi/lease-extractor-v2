-- 0032_insurance_documents_archive.sql
-- Extends the insurance vault (0014) on three fronts:
--   • insurance_documents — extra files attached to a policy (renewals, premium
--     notices, endorsements, or any PDF). Free-form label + optional note; these
--     are plain stored files, no AI extraction.
--   • new insurance_policies columns:
--       premium_amount       — optional premium key-fact (e.g. annual premium).
--       archived_at          — soft-delete; non-null = moved to "expired items in
--                              history" (Remove policy → Save to history).
--       expiry_notice_bucket — dedupes expiry reminder emails so a policy is
--                              emailed once per threshold (1m → 2w → 1w → expired);
--                              reset to null whenever expiry_date changes.

alter table insurance_policies add column if not exists premium_amount       numeric;
alter table insurance_policies add column if not exists archived_at          timestamptz;
alter table insurance_policies add column if not exists expiry_notice_bucket text;

-- Active-policy lookups (the card + alerts) filter on archived_at is null.
create index if not exists insurance_policies_active_idx
  on insurance_policies (property_id, lease_id) where archived_at is null;

create table if not exists insurance_documents (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  policy_id    uuid not null references insurance_policies (id) on delete cascade,
  label        text not null,
  storage_path text,            -- optional uploaded file (lease-documents bucket)
  note         text,            -- optional remark (e.g. premium amount, remarks)
  created_at   timestamptz not null default now()
);
create index if not exists insurance_documents_policy_idx on insurance_documents (policy_id);

alter table insurance_documents enable row level security;
create policy owner_all on insurance_documents for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
