-- 0035_assignment_and_history.sql
-- Phase 2/3 groundwork:
--   1) An addendum can now be a change-of-tenant ASSIGNMENT (e.g. "Assignment and
--      Assumption of Lease" — the practice is sold and the lease is handed to a new
--      tenant). Applying it swaps the tenant identity on the lease.
--   2) A per-building/lease history_events log so the prior tenant (and, later, other
--      lifecycle events) are preserved and surfaced on each property's History.
-- Additive and safe to run on the live project.

-- 1) allow kind = 'assignment' on addendum records
alter table public.lease_addendums drop constraint if exists lease_addendums_kind_check;
alter table public.lease_addendums
  add constraint lease_addendums_kind_check
  check (kind in ('extension', 'rent_change', 'new_option', 'assignment', 'other'));

-- 2) history_events — a lightweight, owner-scoped event log per property/lease.
--    type ∈ tenant_assigned | term_extended | rent_stepped | renewal_added |
--          renewal_confirmed | renewal_declined | lease_created | insurance_archived | …
create table if not exists public.history_events (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  property_id  uuid references public.properties (id) on delete cascade,
  lease_id     uuid references public.leases (id) on delete set null,
  type         text not null,
  description  text not null,
  event_date   date,
  meta         jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists history_events_property_idx on public.history_events (property_id);
create index if not exists history_events_lease_idx    on public.history_events (lease_id);

alter table public.history_events enable row level security;
do $$ begin
  create policy owner_all on public.history_events for all
    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;
