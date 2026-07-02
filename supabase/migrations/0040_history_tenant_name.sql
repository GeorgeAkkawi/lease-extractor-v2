-- 0040_history_tenant_name.sql
-- Record WHICH tenant each history event was about, so the "Lease & tenant history"
-- timeline can attribute every row to a tenant (before this, events listed with no
-- tenant — confusing when a building has several). Denormalized at write time so the
-- attribution is stable even if the lease is later reassigned to a new tenant; the app
-- falls back to the lease's current tenant for any pre-existing rows. Additive + safe.
alter table public.history_events add column if not exists tenant_name text;
