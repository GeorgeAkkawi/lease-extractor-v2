-- CAM is made up of many sub-expenses (landscaping, snow, security, utilities…).
-- Line items live here; the app sums them and writes the total into
-- expense_records.cam_total, so every downstream calc (PSF, tenant shares,
-- views) keeps working unchanged.
create table cam_line_items (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  property_id  uuid not null references properties (id) on delete cascade,
  year         int not null,
  label        text not null,
  amount       numeric not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on cam_line_items (property_id, year);

create trigger trg_cam_line_items_updated
  before update on cam_line_items
  for each row execute function set_updated_at();

alter table cam_line_items enable row level security;
create policy owner_all on cam_line_items for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
