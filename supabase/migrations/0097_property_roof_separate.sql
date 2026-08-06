-- 0097 — does THIS building bill roof as its own category?
--
-- George, 2026-08-06: *"can we add a check mark next to roof that switches it on and off if
-- people want? like some people might just throw it in a cam expense if repairs ever happen
-- to it but others might want it separate."*
--
-- ⚠ THIS FLAG MOVES NO MONEY, AND THAT IS THE ENTIRE DESIGN. It decides what Amlak OFFERS on
-- a property's screens, never what a tenant is charged. Nothing reads it in `v_tenant_shares`,
-- `v_property_totals`, `billedComponents`, `componentizeSchedule`, `draft-invoice` or any
-- stored invoice — checked, and it must stay that way.
--
-- The reason is not caution, it is arithmetic: roof and CAM DO NOT SPLIT THE SAME WAY.
-- `v_tenant_shares.roof_amt` is pro-rata by floor area and deliberately ignores
-- `share_override_pct` (0073:76), while `cam_amount` honours it (0073:74). So actually folding
-- a roof figure into CAM re-prices every tenant holding an override — and would break
-- `fixed_assets.amortize_into = 'roof'` (0080), which exists precisely so a capitalized roof
-- returns to roof and only roof-responsible tenants pay for it. A checkbox must not do that.
--
-- ⚠ AND "OFF" ONLY HIDES WHAT IS EMPTY (George's own call). Where roof already carries a
-- figure — a year with a roof total, or any lease still roof-responsible — every roof surface
-- keeps rendering regardless of this flag. A landlord must never be billing something the app
-- has stopped showing him. `src/lib/roofDisplay.js` is the one place that rule lives.
--
-- PER PROPERTY, not per account: one landlord owns a building with a roof clause and one
-- without. That is a first for this table — `properties` has had exactly one column added in
-- its history (`building_sf`, 0005) — and it is a deliberate departure from 0075:70-72, which
-- scoped expense BUCKETS owner-wide. A bucket is a label offered everywhere; this is a fact
-- about one building's leases.
--
-- `not null default true` IS THE BACKFILL. Every existing property keeps today's behaviour
-- with no data migration, which is the one place this beats routing the setting through
-- `features.js` — that path needs an 0084-style backfill per key or it ships OFF for every
-- account that has ever touched the Settings toggles.

alter table public.properties
  add column if not exists roof_separate boolean not null default true;

comment on column public.properties.roof_separate is
  'Does this building bill roof as its own expense category? Display/offering only — no view, '
  'no billing function and no invoice reads it. False merely stops OFFERING roof here; any '
  'property-year that already holds a roof figure, and any lease still roof-responsible, keeps '
  'showing roof anyway (src/lib/roofDisplay.js). Turning it off never moves a figure into CAM.';
