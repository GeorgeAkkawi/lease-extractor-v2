-- 0033_tenant_second_email.sql
-- A lease can list two contact emails (e.g. a billing address and a person's
-- address). Store a second optional email on the lease, surface it on
-- v_tenant_shares so invoices can offer it, and carry it on lease-change
-- notifications so the bell's prepared tenant email can target either / both.

alter table leases
  add column if not exists tenant_email_2 text;

alter table notifications
  add column if not exists email_to_2 text;

-- Surface tenant_email_2 on the shares view. Appended at the END of the select
-- list so CREATE OR REPLACE accepts it (Postgres only allows new view columns
-- after the existing ones, never mid-list). Body mirrors the latest definition
-- in 0021; security_invoker preserved so RLS on the base tables still applies.
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
  case when l.roof_responsible and pt.total_sf > 0 then coalesce(er.roof_total, 0) * (l.square_footage / pt.total_sf) else 0 end as roof_amt,
  l.tenant_email_2
from leases l
join periods pr on pr.property_id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id
where l.is_active;
alter view v_tenant_shares set (security_invoker = on);

-- Extend the recipient-fill trigger (0027) so cron-applied lease-change
-- notifications also carry the second email. Same NULL-guard idempotency: it
-- only fills email_to_2 when the insert left it blank, so the JS path (which
-- sets it directly) is never overwritten. The trg_fill_notification_recipient
-- trigger already points at this function — replacing the body is enough.
create or replace function public.fill_notification_recipient()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('escalation_applied', 'renewal_applied') then
    if new.email_to is null and new.lease_id is not null then
      select tenant_email into new.email_to
        from public.leases where id = new.lease_id;
    end if;
    if new.email_to_2 is null and new.lease_id is not null then
      select tenant_email_2 into new.email_to_2
        from public.leases where id = new.lease_id;
    end if;
    if new.email_from is null and new.corporation_id is not null then
      select contact_email into new.email_from
        from public.corporations where id = new.corporation_id;
    end if;
  end if;
  return new;
end;
$$;
