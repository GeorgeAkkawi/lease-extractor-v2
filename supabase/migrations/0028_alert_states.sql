-- 0028_alert_states.sql
-- Server-side dismiss / snooze for computed alerts, so "Remind me later" and
-- "Dismiss" follow the landlord across devices (previously localStorage, per-browser).
-- DB notifications already sync (they're rows); this brings the date-derived alerts
-- to parity. Keyed by the same stable alert_key the UI uses (focus:lease_id:date).

create table alert_states (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  alert_key     text not null,
  dismissed     boolean not null default false,
  snoozed_until timestamptz,
  updated_at    timestamptz not null default now(),
  unique (owner_id, alert_key),
  constraint ck_alert_key_len check (char_length(alert_key) between 1 and 300)
);
create index on alert_states (owner_id);

create trigger trg_alert_states_updated before update on alert_states
  for each row execute function set_updated_at();

alter table alert_states enable row level security;
do $$ begin
  create policy owner_all on alert_states for all
    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;
