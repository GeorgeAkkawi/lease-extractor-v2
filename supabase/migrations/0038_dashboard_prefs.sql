-- 0038_dashboard_prefs.sql
-- Per-user dashboard display preferences: which Overview widgets the landlord has
-- chosen to hide. Client-writable (the user flips them directly from the Display
-- settings page — no Edge Function needed), one row per user, RLS-scoped to the
-- owner. Same shape/permissions as alert_states (migration 0028).
--
-- hidden_widgets holds the stable widget keys the UI knows about
-- (rent_roll, ar, occupancy, expiring, expirations, alerts). Empty = show all,
-- which is also the default for any account that has never touched the setting.

create table if not exists public.user_preferences (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  hidden_widgets text[]      not null default '{}',
  updated_at     timestamptz not null default now()
);
alter table public.user_preferences enable row level security;

-- A user may read AND write only their own preferences row.
do $$ begin
  create policy user_preferences_owner_all on public.user_preferences for all
    using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;

drop trigger if exists trg_user_preferences_updated on public.user_preferences;
create trigger trg_user_preferences_updated before update on public.user_preferences
  for each row execute function set_updated_at();
