-- 0027_notification_email_recipient.sql
-- Backfill the tenant recipient on cron-applied lease notifications.
--
-- Two engines create 'escalation_applied' / 'renewal_applied' notifications:
--   • the in-app JS (applyEscalation / applyDueRenewals in src/lib/api.js) sets
--     email_to (tenant) and email_from (corporation contact) on the insert.
--   • the server-side SQL engines (apply_due_escalations / apply_due_renewals in
--     0022) build the same email_subject/email_body but do NOT set email_to /
--     email_from.
-- Because the daily pg_cron run (0024, 06:00 UTC) usually applies a due change
-- before anyone opens the app, the prepared tenant email lands without a
-- recipient. This trigger fills email_to / email_from from the lease + its
-- corporation whenever they're absent, so both paths yield an identical,
-- sendable notification. Idempotent with the JS path (the NULL guards skip rows
-- that already carry a recipient), and scoped to the two lease-change kinds so
-- it never touches reminder or in-app-only notifications.

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
    if new.email_from is null and new.corporation_id is not null then
      select contact_email into new.email_from
        from public.corporations where id = new.corporation_id;
    end if;
  end if;
  return new;
end;
$$;

-- Scheduler/server path only invokes the apply functions; the trigger itself runs
-- for every notification insert, so no extra grants are required.
drop trigger if exists trg_fill_notification_recipient on public.notifications;
create trigger trg_fill_notification_recipient
  before insert on public.notifications
  for each row execute function public.fill_notification_recipient();

-- ---------------------------------------------------------------------------
-- One-time backfill: patch the lease-change notifications the cron already
-- created without a recipient. This migration runs once, so this runs once.
-- Each statement only fills the field that's still empty.
-- ---------------------------------------------------------------------------
update public.notifications n
   set email_to = l.tenant_email
  from public.leases l
 where n.kind in ('escalation_applied', 'renewal_applied')
   and n.email_to is null
   and n.lease_id = l.id;

update public.notifications n
   set email_from = c.contact_email
  from public.corporations c
 where n.kind in ('escalation_applied', 'renewal_applied')
   and n.email_from is null
   and n.corporation_id = c.id;
