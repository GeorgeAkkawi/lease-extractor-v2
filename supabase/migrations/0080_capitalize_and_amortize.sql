-- 0080 — Slice 5b. An expense can become an asset, and an asset can bill itself back.
--
-- WHAT ROUND 9 LEFT UNFINISHED, named on its own panel rather than discovered: recording
-- a roof in the asset register while the same roof still sits in this year's roof_total
-- tells the app about it twice. Taking it OUT of the expense is a REAL BILLING CHANGE —
-- roof_total feeds v_property_totals and every roof-responsible tenant's roof_amt — so it
-- has to run the full carry-through (resyncPropertyBilling → settleBillingChange). That
-- is why this is its own round and not a footnote to the last one.
--
-- THREE COLUMNS, NO NEW TABLE, NOTHING ALTERED IN PLACE.
--
--   fixed_assets.import_id      — round 9 deliberately refused this ("a column with no
--                                 writer is the write-only-data antipattern"). Slice 5b
--                                 is the writer: an asset capitalized straight off a bank
--                                 line keeps its provenance back to the stored statement
--                                 PDF, exactly as payments and expense lines already do.
--
--   fixed_assets.amortize_into  — which expense kind this asset bills back through, or
--                                 NULL for "it doesn't." See the note below; this is the
--                                 column the whole round turns on.
--
--   cam_line_items.asset_id     — the link column, the exact shape contract_id has had
--                                 since 0042. A derived amortization row is owned by its
--                                 asset: it is refreshed when the figure drifts, removed
--                                 when the asset stops amortizing, and cascades away with
--                                 the asset itself.
--
-- ⚠ WHY amortize_into IS A KIND AND NOT A BOOLEAN, and it is the correction this round
-- exists to make. The direction doc said a capitalized cost comes back as "a CAM
-- amortization line." That is wrong, and Pershing proves it: roof costs are billed
-- ONLY to leases carrying roof_responsible — 1 of its 9 — while CAM is billed pro-rata
-- to all of them. Pushing an amortized roof into CAM would move roughly $17,000 of an
-- $18,000 roof onto eight tenants whose leases do not make them responsible for it. So
-- the asset remembers WHICH KIND OF EXPENSE IT CAME FROM and amortizes back into that
-- same kind: a roof returns to roof, a parking lot to CAM. The same tenants pay, spread
-- over the life instead of landed in one year.
--
-- ⚠ AND IT IS NULL BY DEFAULT — nothing amortizes until the landlord says so. Whether a
-- particular lease permits a capital cost to be amortized into CAM is a LEASE question
-- Amlak cannot answer from the schema, and auto-billing tenants for something their
-- lease may not allow is the cam_capped problem with the sign flipped. Opt-in, with the
-- consequence named at the moment it is switched on.

alter table public.fixed_assets
  add column if not exists import_id uuid references public.statement_imports (id) on delete set null;

-- Deliberately NOT a CHECK. The valid values are 'cam' and 'roof' today; a future round
-- that adds an expense kind should not need a migration to let an asset amortize into it,
-- and a CHECK would reject a row the app considers valid. Same call ASSET_KINDS,
-- DISPOSITIONS, ENTITY_KINDS and EXPENSE_CATEGORIES all make.
alter table public.fixed_assets
  add column if not exists amortize_into text;

alter table public.cam_line_items
  add column if not exists asset_id uuid references public.fixed_assets (id) on delete cascade;

create index if not exists cam_line_items_asset_idx on public.cam_line_items (asset_id);
create index if not exists fixed_assets_import_idx on public.fixed_assets (import_id);

comment on column public.fixed_assets.amortize_into is
  'Expense kind this asset bills back through (cam | roof), or null for not billed back. A roof returns to roof so only roof_responsible leases pay it.';
comment on column public.cam_line_items.asset_id is
  'Set on a DERIVED amortization row. Owned by syncAmortizationItems — refreshed, removed and cascaded with its asset.';
