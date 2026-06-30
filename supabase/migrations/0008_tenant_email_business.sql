-- 0008_tenant_email_business.sql
-- Recipient info on leases, a recipient on renewal/escalation notifications, and
-- an owner-level business profile used as letterhead/signature in tenant emails.

alter table leases
  add column if not exists tenant_email text,
  add column if not exists tenant_contact_name text;

alter table notifications
  add column if not exists email_to text;

-- One business profile per owner (the sender identity on every tenant email).
create table if not exists business_profile (
  owner_id      uuid primary key references auth.users(id) on delete cascade,
  company_name  text,
  address       text,
  contact_email text,
  contact_phone text,
  updated_at    timestamptz not null default now()
);
alter table business_profile enable row level security;
do $$ begin
  create policy business_profile_owner on business_profile
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Recreate v_tenant_shares to also surface the recipient fields (so invoices can
-- pre-fill the "To" address). Definition mirrors 0005 plus tenant_email/contact.
-- drop + recreate (not CREATE OR REPLACE): tenant_email/tenant_contact_name are
-- inserted mid-list, which Postgres rejects on replace. No dependents → safe.
drop view if exists v_tenant_shares;
create view v_tenant_shares as
select
  l.id            as lease_id,
  l.property_id,
  l.tenant_name,
  l.tenant_email,
  l.tenant_contact_name,
  er.year,
  l.square_footage,
  l.roof_responsible,
  effective_rent(l.id, er.year) as base_rent,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) as share_pct,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * er.taxes_total as tax_amount,
  coalesce(l.share_override_pct, case when pt.total_sf > 0 then l.square_footage / pt.total_sf end) * er.cam_total   as cam_amount,
  case when l.roof_responsible and pt.total_sf > 0 then er.roof_total * (l.square_footage / pt.total_sf) else 0 end as roof_amt
from leases l
join expense_records er on er.property_id = l.property_id
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases group by property_id) pt
  on pt.property_id = l.property_id;
