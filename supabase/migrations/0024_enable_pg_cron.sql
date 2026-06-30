-- 0024_enable_pg_cron.sql
-- Turn on hands-off daily processing of due lease changes. pg_cron is preloaded on
-- Supabase; enabling the extension registers the scheduler, then we schedule the
-- daily run of apply_due_changes() (escalations + renewals, hardened in 0022).
-- The job runs server-side as the scheduler role — no browser needed.
create extension if not exists pg_cron;

-- Idempotent (re)schedule: drop any prior job of the same name first.
do $$
begin
  perform cron.unschedule('apply-due-lease-changes');
exception when others then
  null; -- no existing job → nothing to unschedule
end;
$$;

select cron.schedule('apply-due-lease-changes', '0 6 * * *', 'select public.apply_due_changes();');
