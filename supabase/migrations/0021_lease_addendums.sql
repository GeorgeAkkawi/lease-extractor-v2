-- 0021_lease_addendums.sql
-- Adds: (1) a tracked Addendum/Rider record per lease that pushes escalation/
-- renewal/term updates into the existing engine; (2) provenance links from
-- escalations/renewals back to the addendum that created them; (3) a lease
-- is_active flag so a fully-expired ("outdated") lease contributes no financials
-- until an extension activates it; (4) Word .docx uploads in the storage bucket.
-- All additive and safe to run on the live project.

-- ===========================================================================
-- 1) Addendum / rider records
-- ===========================================================================
create table if not exists lease_addendums (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  lease_id       uuid not null references leases (id) on delete cascade,
  label          text,
  amendment_date date,
  kind           text not null default 'other'
                   check (kind in ('extension', 'rent_change', 'new_option', 'other')),
  summary        text,
  storage_path   text,                 -- attached rider PDF/scan/photo/Word (optional)
  addendum_text  text,                 -- cached transcription for AI Q&A
  extraction_raw jsonb,                -- raw AI extraction for audit
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ck_add_label_len   check (label is null or char_length(label) <= 200),
  constraint ck_add_summary_len check (summary is null or char_length(summary) <= 20000),
  constraint ck_add_text_len    check (addendum_text is null or char_length(addendum_text) <= 5000000),
  constraint ck_add_path_len    check (storage_path is null or char_length(storage_path) <= 1024)
);
create index if not exists lease_addendums_lease_idx on lease_addendums (lease_id);

create trigger trg_lease_addendums_updated before update on lease_addendums
  for each row execute function set_updated_at();

alter table lease_addendums enable row level security;
do $$ begin
  create policy owner_all on lease_addendums for all
    using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 2) Provenance: which addendum created an escalation / renewal option
-- ===========================================================================
alter table rent_escalations add column if not exists addendum_id uuid references lease_addendums (id) on delete set null;
alter table renewal_options  add column if not exists addendum_id uuid references lease_addendums (id) on delete set null;

-- ===========================================================================
-- 3) Lease active flag — fully-expired ("outdated") leases are excluded from the
--    financial views until an extension/addendum brings the term current.
-- ===========================================================================
alter table leases add column if not exists is_active boolean not null default true;

-- Re-create the reporting views with `where l.is_active` on every lease reference.
-- Column lists are unchanged from 0016, so create-or-replace is accepted; we
-- re-assert security_invoker (per 0017) afterward to keep RLS enforced via the views.
create or replace view v_property_totals as
with leased as (
  select property_id,
         coalesce(sum(square_footage), 0) as total_sf,
         coalesce(sum(square_footage) filter (where roof_responsible), 0) as resp_sf
  from leases where is_active group by property_id
),
periods as (
  select property_id, year from expense_records
  union
  select distinct l.property_id, gs.year
  from leases l
  cross join generate_series(
    extract(year from now())::int - 6,
    extract(year from now())::int + 1
  ) as gs(year)
  where l.is_active
)
select
  p.id                                              as property_id,
  pr.year,
  coalesce(ls.total_sf, 0)                          as total_sf,
  coalesce(p.building_sf, ls.total_sf, 0)           as building_sf,
  greatest(0, coalesce(p.building_sf, ls.total_sf, 0) - coalesce(ls.total_sf, 0)) as vacant_sf,
  case when coalesce(p.building_sf, ls.total_sf, 0) > 0
       then coalesce(ls.total_sf, 0) / coalesce(p.building_sf, ls.total_sf, 0) end as occupancy,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id and l.is_active), 0) as total_revenue,
  coalesce(er.taxes_total, 0)                       as taxes_total,
  coalesce(er.cam_total, 0)                         as cam_total,
  coalesce(er.roof_total, 0)                        as roof_total,
  (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as total_expenses,
  coalesce((select sum(effective_rent(l.id, pr.year)) from leases l where l.property_id = p.id and l.is_active), 0)
    - (coalesce(er.taxes_total, 0) + coalesce(er.cam_total, 0) + coalesce(er.roof_total, 0)) as noi,
  case when ls.total_sf > 0 then coalesce(er.taxes_total, 0) / ls.total_sf end as tax_psf,
  case when ls.total_sf > 0 then coalesce(er.cam_total, 0) / ls.total_sf end   as cam_psf,
  case when ls.total_sf > 0 then coalesce(er.roof_total, 0) / ls.total_sf end  as roof_psf_rate,
  case when ls.total_sf > 0 then coalesce(er.roof_total, 0) * (ls.resp_sf / ls.total_sf) else 0 end as roof_recovered,
  coalesce(er.roof_total, 0) - (case when ls.total_sf > 0 then coalesce(er.roof_total, 0) * (ls.resp_sf / ls.total_sf) else 0 end) as roof_unrecovered
from properties p
join periods pr on pr.property_id = p.id
left join expense_records er on er.property_id = p.id and er.year = pr.year
left join leased ls on ls.property_id = p.id;

create or replace view v_tenant_shares as
with periods as (
  select property_id, year from expense_records
  union
  select distinct l.property_id, gs.year
  from leases l
  cross join generate_series(
    extract(year from now())::int - 6,
    extract(year from now())::int + 1
  ) as gs(year)
  where l.is_active
)
select
  l.id            as lease_id,
  l.property_id,
  l.tenant_name,
  l.tenant_email,
  l.tenant_contact_name,
  pr.year,
  l.square_footage,
  l.roof_responsible,
  effective_rent(l.id, pr.year) as base_rent,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) as share_pct,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * coalesce(er.taxes_total, 0) as tax_amount,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * coalesce(er.cam_total, 0)   as cam_amount,
  case when l.roof_responsible and pt.total_sf > 0 then coalesce(er.roof_total, 0) * (l.square_footage / pt.total_sf) else 0 end as roof_amt
from leases l
join periods pr on pr.property_id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id
where l.is_active;

alter view v_property_totals set (security_invoker = on);
alter view v_tenant_shares  set (security_invoker = on);

-- ===========================================================================
-- 4) Storage: allow Word .docx uploads (in addition to PDF + images)
-- ===========================================================================
update storage.buckets
   set allowed_mime_types = array[
         'application/pdf',
         'image/png',
         'image/jpeg',
         'image/webp',
         'image/gif',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
       ]
 where id = 'lease-documents';
