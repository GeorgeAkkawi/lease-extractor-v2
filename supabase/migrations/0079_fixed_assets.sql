-- 0079 — Slice 5a: the asset register.
--
-- THE GAP. Amlak has never held the idea that a thing can be bought once and used for
-- thirty-nine years. An $18,000 roof is an $18,000 expense in the year it was paid, so
-- that year reads as a disaster and every other year reads better than it was. And the
-- largest asset a landlord owns cannot be described at all: `properties` has had
-- exactly ONE column added since 0001 (`building_sf`, 0005) — no acquisition date, no
-- purchase price, nothing.
--
-- ⚠ THIS MIGRATION ALTERS NOTHING. One new table, no view, no RPC, no CHECK widened, no
-- existing column touched. Not one stored total can move, and no tenant's bill can
-- change — because depreciation is a NON-CASH figure that no view, no invoice and no
-- share calculation will ever read. The same structural safety `entity_ledger` (0077)
-- and `other_income` (0078) have, for the same reason: the safety is in what reads the
-- table, not in how carefully the code is written.
--
-- ⚠ AND IT DELIBERATELY DOES NOT ADD `properties.purchase_price`. The building is an
-- ASSET like the roof is, so it belongs in the register with one cost, one in-service
-- date and one land allocation — not special-cased into two columns with their own
-- rules. That keeps ONE depreciation rule for everything, and it leaves the
-- closing-statement extractor (Slice 5c) a row to fill rather than a second schema to
-- reconcile against this one.
--
-- WHAT IS REFUSED, in the schema itself:
--   * No MACRS, bonus or §179 columns. Straight-line, book only. Being subtly wrong
--     about an election is worse than being absent, and elections are the CPA's.
--   * No disposal columns. Selling an asset raises gain/loss and recapture, which is a
--     decision rather than arithmetic — it gets built when it is built, not stubbed out
--     as columns nothing writes.
--   * No `import_id`. Nothing imports an asset yet; capitalizing at review is Slice 5b,
--     and that round adds the column alongside the code that writes it. A column with
--     no writer is the write-only-data antipattern this codebase keeps finding.

create table if not exists public.fixed_assets (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references auth.users (id) on delete cascade,
  -- NOT NULL. A depreciable asset is a physical thing standing at a building — and it
  -- has to be, because Slice 5b amortizes it back into that property's CAM. An
  -- entity-level cost that belongs to no building already has a home: entity_ledger.
  property_id           uuid not null references public.properties (id) on delete cascade,

  -- The kind, from the JS registry in src/lib/depreciation.js. No CHECK, for the reason
  -- 0075/0076/0077/0078 all give: a CHECK means a migration every time the list grows,
  -- and it would reject a row the app itself considers valid.
  kind                  text,
  description           text,

  -- ⚠ NOTE WHAT IS ABSENT: there is no `year`. Every other money table in this app is
  -- keyed to a fiscal year because every other figure belongs to one. An asset belongs
  -- to all of them — it has a date it entered service and a life that spans decades,
  -- and the year's figure is DERIVED. That difference is the whole feature.
  placed_in_service     date,
  cost                  numeric(14,2) not null default 0,

  -- ⚠ NULLABLE ON PURPOSE, AND null IS NOT ZERO. The land/building split is the most
  -- consequential number in depreciation and Amlak cannot know it: it is an allocation
  -- DECISION, not a fact printed on the settlement statement. A ground lease or a condo
  -- unit legitimately has 0 here; a building nobody has split has null, and the app
  -- refuses to depreciate it until someone answers. An 80/20 default is one line of
  -- code and silently wrong on most properties.
  land_cost             numeric(14,2),

  -- Pre-filled from the kind and always editable. The defaults assume nonresidential
  -- property (39 years for the structure); a residential landlord would use 27.5.
  useful_life_years     numeric(6,2),

  -- The cross-check, not a correction. A landlord who has owned a building for ten
  -- years already has this figure on the CPA's last Form 4562; the schedule here is
  -- computed independently, so the two are two SOURCES for one number. They will almost
  -- never match exactly — a CPA applies the mid-month convention and this app prorates
  -- by whole months — and the app says so rather than treating a small gap as a fault.
  prior_accumulated     numeric(14,2),
  prior_accumulated_year int,

  note                  text,
  created_at            timestamptz not null default now()
);

create index if not exists fixed_assets_owner_idx on public.fixed_assets (owner_id);
create index if not exists fixed_assets_prop_idx on public.fixed_assets (property_id);
create index if not exists fixed_assets_service_idx on public.fixed_assets (placed_in_service);

alter table public.fixed_assets enable row level security;

do $$
begin
  create policy owner_all on public.fixed_assets
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null;
end $$;

-- Every owner-scoped table carries this since 0052. Dormant until a user enrols a
-- second factor; it must not be the one table that forgets.
do $$
begin
  create policy require_aal2 on public.fixed_assets
    as restrictive for all
    using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null;
end $$;

comment on table public.fixed_assets is
  'Depreciable assets at a property — the building, its improvements, land improvements, '
  'equipment. Read by NO view, NO invoice and NO share calculation: depreciation is a '
  'non-cash figure, so recording an asset here can never move a tenant''s bill or an '
  'expense total. Straight-line book depreciation is DERIVED from these columns by '
  'src/lib/depreciation.js and is never stored. MACRS, bonus and section 179 are '
  'deliberately not modelled — capturing the basis is the half Amlak does better than '
  'anyone; applying the elections is the accountant''s.';
