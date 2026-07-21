-- 0063_statement_imports.sql
-- Bank-statement import (Rent Ledger Stage 2): two new owner-scoped tables + two
-- provenance columns each on payments / cam_line_items.
--
-- Additive / non-destructive: new tables + nullable ADD COLUMNs only — no changes
-- to any existing view, function, or row. Safe to re-run (IF NOT EXISTS + guarded
-- policy creation).
--
-- Rule-#7 check (views selecting X.* from an altered table): no view selects
-- payments.* or cam_line_items.* — v_invoice_balances only AGGREGATES payments
-- (sum(p.amount)) and nothing selects cam_line_items — so no view rebuild is
-- needed for the two ADD COLUMNs.
--
--   • import_rules      — the payee memory ("always match HEGAZY → D & D Dental"):
--                         a case-insensitive contains-pattern per property that
--                         pre-classifies a statement line. Rules pin to lease_id so
--                         a tenant rename can't break them; cam_label names the CAM
--                         line an expense rule books to. Suggest-only by design —
--                         every import still passes the review screen.
--   • statement_imports — one row per imported statement: file name, the masked
--                         bank-account hint (powers "Account ••4821 — last imported
--                         into Pershing Plaza"), and `applied` — the exact record of
--                         every write the import made, which powers a precise undo.
--   • payments.import_id/import_hash — which import created a payment and the
--                         line-hash used to grey out already-imported lines on the
--                         next upload. NO unique index on import_hash on purpose:
--                         two identical legitimate checks must both be recordable
--                         ("import anyway" override).
--   • cam_line_items.import_id — marks imported CAM rows (an "imported" badge in
--                         the UI; they keep their ✕, unlike contract-synced rows).

create table if not exists public.import_rules (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  property_id  uuid not null references public.properties (id) on delete cascade,
  pattern      text not null check (char_length(pattern) >= 3),
  target_kind  text not null check (target_kind in ('tenant','expense_tax','expense_cam','expense_roof','ignore')),
  lease_id     uuid references public.leases (id) on delete cascade,
  cam_label    text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One rule per (owner, property, pattern) — saving the same pattern again updates
-- the existing rule instead of stacking duplicates.
create unique index if not exists import_rules_pattern_idx
  on public.import_rules (owner_id, property_id, lower(pattern));

drop trigger if exists trg_import_rules_updated on public.import_rules;
create trigger trg_import_rules_updated
  before update on public.import_rules
  for each row execute function set_updated_at();

alter table public.import_rules enable row level security;

do $$ begin
  create policy owner_all on public.import_rules for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy require_aal2 on public.import_rules
    as restrictive to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null; end $$;

create table if not exists public.statement_imports (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  property_id   uuid not null references public.properties (id) on delete cascade,
  year          int,
  file_name     text,
  storage_path  text,
  account_hint  text,
  applied       jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists statement_imports_property_idx
  on public.statement_imports (property_id, created_at desc);

alter table public.statement_imports enable row level security;

do $$ begin
  create policy owner_all on public.statement_imports for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy require_aal2 on public.statement_imports
    as restrictive to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null; end $$;

-- Provenance columns. import_id is SET NULL on delete so undoing/removing an import
-- record never cascades away real money rows (undo deletes payments explicitly, by
-- its `applied` record).
alter table public.payments
  add column if not exists import_id uuid references public.statement_imports (id) on delete set null;
alter table public.payments
  add column if not exists import_hash text;

-- The dedupe guard scans the owner's existing hashes on every import preview.
create index if not exists payments_import_hash_idx
  on public.payments (owner_id, import_hash) where import_hash is not null;

alter table public.cam_line_items
  add column if not exists import_id uuid references public.statement_imports (id) on delete set null;
