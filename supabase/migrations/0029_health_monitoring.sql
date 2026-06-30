-- 0029_health_monitoring.sql
-- Daily, OPERATOR-ONLY backend health check. An always-on pg_cron job calls the
-- `health-check` edge function each morning; the function gathers read-only
-- metrics (security activity, capacity, growth, app health) via
-- collect_health_metrics(), records one row in health_reports, and — only when
-- something needs attention — emails the single operator address.
--
-- DEVELOPER-ONLY by design: health_reports has RLS enabled with NO policy, so it
-- is unreachable through the public REST API by any tenant/user (same technique
-- as ai_rate_limit in 0018). Only the service role (which bypasses RLS) writes
-- it; the operator reads history in the Supabase dashboard. Nothing here writes
-- to the customer-facing `notifications` table, and the function only ever emails
-- ADMIN_ALERT_EMAIL — never a tenant address.
--
-- Required at deploy (set out-of-band, NEVER committed):
--   • Edge-function secrets: CRON_SECRET, ADMIN_ALERT_EMAIL, RESEND_API_KEY,
--     HEALTH_FROM_EMAIL (+ optional DB_LIMIT_MB / STORAGE_LIMIT_MB to match plan).
--   • Vault secrets (read by the cron command below, so the value never appears in
--     source or in cron.job):
--       select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--       select vault.create_secret('<CRON_SECRET value>',        'cron_secret');

-- pg_net lets Postgres (the cron job) make the outbound HTTPS call to the function.
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Durable, operator-only history of every run.
-- ---------------------------------------------------------------------------
create table if not exists public.health_reports (
  id        uuid primary key default gen_random_uuid(),
  ran_at    timestamptz not null default now(),
  severity  text not null check (severity in ('ok', 'warn', 'critical')),
  summary   text,
  findings  jsonb not null default '[]'::jsonb,
  constraint ck_health_summary_len check (summary is null or char_length(summary) <= 4000)
);
create index if not exists health_reports_ran_at_idx on public.health_reports (ran_at desc);

alter table public.health_reports enable row level security;
-- No policy on purpose: deny all direct API access. The service role bypasses RLS
-- to write/read; the operator reads in the dashboard. Defense-in-depth: also strip
-- the default table grants from anon/authenticated so the data is doubly walled off.
revoke all on public.health_reports from anon, authenticated;
-- The edge function (service role, bypasses RLS) is the only writer/reader.
grant select, insert on public.health_reports to service_role;

-- ---------------------------------------------------------------------------
-- Privileged, read-only metric collection. One SECURITY DEFINER gatherer so the
-- edge function needs a single RPC. Each metric is guarded in its own block, so a
-- permissions hiccup on one source can never sink the whole report. search_path=''
-- → every object is fully schema-qualified.
-- ---------------------------------------------------------------------------
create or replace function public.collect_health_metrics()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_security      jsonb       := '{}'::jsonb;
  v_db_bytes      bigint      := null;
  v_storage_bytes bigint      := null;
  v_top_tables    jsonb       := '[]'::jsonb;
  v_total_users   bigint      := null;
  v_new_users     bigint      := null;
  v_new_leases    bigint      := null;
  v_new_files     bigint      := null;
  v_ai_calls      bigint      := null;
  v_stuck         bigint      := null;
  v_due_status    text        := null;
  v_due_end       timestamptz := null;
begin
  -- Security events grouped by type over the last 24h.
  begin
    select coalesce(jsonb_object_agg(event_type, c), '{}'::jsonb) into v_security
    from (
      select event_type, count(*) as c
      from public.security_events
      where occurred_at > now() - interval '24 hours'
      group by event_type
    ) s;
  exception when others then v_security := '{}'::jsonb; end;

  -- Capacity: database + uploaded-file storage size.
  begin
    v_db_bytes := pg_catalog.pg_database_size(pg_catalog.current_database());
  exception when others then v_db_bytes := null; end;

  begin
    select coalesce(sum((metadata->>'size')::bigint), 0) into v_storage_bytes
    from storage.objects
    where bucket_id = 'lease-documents';
  exception when others then v_storage_bytes := null; end;

  begin
    select coalesce(jsonb_agg(jsonb_build_object('name', relname, 'bytes', bytes) order by bytes desc), '[]'::jsonb)
    into v_top_tables
    from (
      select c.relname as relname, pg_catalog.pg_total_relation_size(c.oid) as bytes
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by bytes desc
      limit 5
    ) t;
  exception when others then v_top_tables := '[]'::jsonb; end;

  -- Growth / load.
  begin select count(*) into v_total_users from auth.users;
  exception when others then v_total_users := null; end;

  begin select count(*) into v_new_users from auth.users
    where created_at > now() - interval '24 hours';
  exception when others then v_new_users := null; end;

  begin select count(*) into v_new_leases from public.leases
    where created_at > now() - interval '24 hours';
  exception when others then v_new_leases := null; end;

  begin select count(*) into v_new_files from public.lease_files
    where created_at > now() - interval '24 hours';
  exception when others then v_new_files := null; end;

  begin select coalesce(sum(count), 0) into v_ai_calls from public.ai_rate_limit
    where window_start > now() - interval '24 hours';
  exception when others then v_ai_calls := null; end;

  -- App health.
  begin select count(*) into v_stuck from public.reminders
    where status = 'pending' and remind_on < current_date;
  exception when others then v_stuck := null; end;

  begin
    select d.status, d.end_time into v_due_status, v_due_end
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where j.jobname = 'apply-due-lease-changes'
    order by d.start_time desc
    limit 1;
  exception when others then v_due_status := null; v_due_end := null; end;

  return jsonb_build_object(
    'generated_at', now(),
    'security', v_security,
    'capacity', jsonb_build_object(
      'db_bytes', v_db_bytes,
      'storage_bytes', v_storage_bytes,
      'top_tables', v_top_tables
    ),
    'growth', jsonb_build_object(
      'total_users', v_total_users,
      'new_users_24h', v_new_users,
      'new_leases_24h', v_new_leases,
      'new_lease_files_24h', v_new_files,
      'ai_calls_24h', v_ai_calls
    ),
    'app', jsonb_build_object(
      'stuck_reminders', v_stuck,
      'apply_due_last_status', v_due_status,
      'apply_due_last_end', v_due_end
    )
  );
end;
$fn$;

-- Only the service role (the edge function) may gather metrics. Block everyone
-- else: this is SECURITY DEFINER, so an exposed grant would leak privileged data.
revoke all on function public.collect_health_metrics() from public, anon, authenticated;
grant execute on function public.collect_health_metrics() to service_role;

-- ---------------------------------------------------------------------------
-- Schedule the daily run at 06:15 — just after the 06:00 apply-due-lease-changes
-- job (0024), so its run status is already recorded when we check it. The project
-- URL + cron secret come from Vault: only the secret NAMES appear here, so values
-- never touch source control or the cron.job table.
-- ---------------------------------------------------------------------------
do $$ begin
  perform cron.unschedule('daily-health-check');
exception when others then null; -- no existing job → nothing to unschedule
end $$;

select cron.schedule(
  'daily-health-check',
  '15 6 * * *',
  $cmd$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/health-check',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $cmd$
);
