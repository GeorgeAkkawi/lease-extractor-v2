-- 0095 — cross-tenant hardening
--
-- Four findings from the 2026-08-05 whole-codebase security review. Every one of
-- them turns on the same structural fact: **no table in this schema has FORCE ROW
-- LEVEL SECURITY**, so a SECURITY DEFINER function runs as the table owner with RLS
-- silently OFF, and **a foreign key check bypasses RLS**, so a row may legally point
-- at a parent belonging to somebody else. RLS itself is sound — all 45 tables have
-- it, every `for all` policy carries a `with check` — but it only ever tests the
-- row's own owner_id. It has never tested the row's PARENT.
--
--   1. A definer trigger read another owner's tenant emails and handed them back.
--   2. Any authenticated user could forge audit entries attributed to anyone.
--   3. A row pointing at someone else's lease could take a global unique slot and
--      permanently suppress that owner's renewal prompt.
--   4. The one definer function whose search_path was not pinned to ''.
--
-- Additive only. No table, column, index or policy is dropped; no row is modified.
-- Verified against production before writing: zero existing rows anywhere in
-- notifications or invoices reference a parent belonging to a different owner, so
-- the new guard rejects nothing that exists today.

-- ---------------------------------------------------------------------------
-- 1. The parent must belong to the same owner as the child.
-- ---------------------------------------------------------------------------
-- This is the root cause behind findings 1 and 3, so it is fixed once, here,
-- rather than separately in each symptom.
--
-- Reads the row through to_jsonb so ONE implementation serves any table carrying
-- these columns — a table without `property_id` simply yields NULL for it and the
-- check is skipped. That is deliberate: a second copy per table is exactly how the
-- three lookups in fill_notification_recipient drifted from the policy in the first
-- place.
--
-- SECURITY DEFINER on purpose. The whole point is to see the parent row EVEN WHEN
-- RLS would hide it — a check that could only see the caller's own rows could not
-- tell "belongs to someone else" apart from "does not exist", and would pass the
-- attack straight through. It reads exactly one uuid per parent and returns it to
-- nobody; the owner comparison is the only thing that escapes.
create or replace function public.assert_parent_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  j        jsonb := to_jsonb(new);
  v_owner  uuid  := nullif(j->>'owner_id', '')::uuid;
  v_id     uuid;
  v_parent uuid;
begin
  -- No owner on the row means RLS's own `with check` will reject it anyway.
  if v_owner is null then
    return new;
  end if;

  v_id := nullif(j->>'lease_id', '')::uuid;
  if v_id is not null then
    select owner_id into v_parent from public.leases where id = v_id;
    if v_parent is distinct from v_owner then
      raise exception 'That lease belongs to a different account.' using errcode = '42501';
    end if;
  end if;

  v_id := nullif(j->>'property_id', '')::uuid;
  if v_id is not null then
    select owner_id into v_parent from public.properties where id = v_id;
    if v_parent is distinct from v_owner then
      raise exception 'That property belongs to a different account.' using errcode = '42501';
    end if;
  end if;

  v_id := nullif(j->>'corporation_id', '')::uuid;
  if v_id is not null then
    select owner_id into v_parent from public.corporations where id = v_id;
    if v_parent is distinct from v_owner then
      raise exception 'That business belongs to a different account.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.assert_parent_owner() from public, anon, authenticated;

-- Named with a leading `a` so it fires BEFORE trg_fill_notification_recipient —
-- Postgres runs same-timing triggers in name order, and a row that is about to be
-- rejected should never reach the code that fills in an email address.
drop trigger if exists trg_a_assert_parent_owner on public.notifications;
create trigger trg_a_assert_parent_owner
  before insert or update on public.notifications
  for each row execute function public.assert_parent_owner();

drop trigger if exists trg_a_assert_parent_owner on public.invoices;
create trigger trg_a_assert_parent_owner
  before insert or update on public.invoices
  for each row execute function public.assert_parent_owner();

-- NOTE ON FINDING 3, and why the unique indexes are deliberately LEFT ALONE.
--
-- The attack was: insert a `renewal_decision` notification carrying your own
-- owner_id but someone else's lease_id, and the global partial unique index
-- notifications_one_open_renewal_decision (lease_id) — which raises regardless of
-- RLS visibility — then blocks apply_due_renewals() from ever creating that
-- owner's prompt again. The obvious fix, adding owner_id to the index, would
-- BREAK the nightly sweep: apply_due_renewals() infers that exact index by column
-- list at 0068_renewal_notice_lapse.sql:108
--     on conflict (lease_id) where kind = 'renewal_decision' do nothing
-- and a widened index no longer matches the inference specification, so every
-- nightly run would fail with 42P10 instead of no-opping. Same reasoning for
-- invoices_one_live_per_lease_year (0055_invoice_integrity.sql:45).
--
-- The trigger above closes the attack at its source instead: the poisoned row can
-- no longer be inserted at all, so the slot it would have taken is never taken,
-- and both indexes keep the exact shape their callers infer. It also closes the
-- 23505/23503 existence oracle, which widening the index would not have.

-- ---------------------------------------------------------------------------
-- 2. The notification-recipient trigger must not read across accounts.
-- ---------------------------------------------------------------------------
-- Unchanged from 0033_tenant_second_email.sql except for the `and owner_id =
-- new.owner_id` on each of the three lookups. Same signature, same trigger, so
-- nothing needs re-installing.
--
-- The parentage guard above already makes a cross-owner lease_id unreachable here,
-- so this is defence in depth — but it is the cheap half of the pair and it is the
-- half that states the rule where the read actually happens. Without it, anyone
-- later attaching this trigger to another table, or relaxing the guard, silently
-- reopens a confirmed cross-tenant read of tenant PII.
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
        from public.leases where id = new.lease_id and owner_id = new.owner_id;
    end if;
    if new.email_to_2 is null and new.lease_id is not null then
      select tenant_email_2 into new.email_to_2
        from public.leases where id = new.lease_id and owner_id = new.owner_id;
    end if;
    if new.email_from is null and new.corporation_id is not null then
      select contact_email into new.email_from
        from public.corporations where id = new.corporation_id and owner_id = new.owner_id;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. An audit entry may only be attributed to the caller.
-- ---------------------------------------------------------------------------
-- log_security_event is SECURITY DEFINER and granted to `authenticated`
-- (0020_security_hardening.sql:231), and it wrote `coalesce(p_actor, auth.uid())`
-- — so any signed-in user could file security_events against any other user, with
-- 1000 characters of their own text in `detail`. The victim reads those back
-- through security_events_read_own, and they feed collect_health_metrics()'s 24h
-- roll-up and the operator alert email.
--
-- The PARAMETER IS KEPT rather than dropped. Dropping it would change the
-- signature, and _shared/ratelimit.ts is imported by 26 edge functions that would
-- all need redeploying in the same round to avoid a mismatch — for no security
-- gain, since the guard below is what actually closes the hole.
--
-- The guard is written so the SERVICE ROLE still passes: a cron caller has no user
-- JWT, so auth.uid() is null and p_actor is honoured as before (send-reminders and
-- health-check both rely on that). It is only a caller who HAS an identity and
-- claims a different one that is refused.
create or replace function public.log_security_event(
  p_event_type text,
  p_fn         text default null,
  p_detail     text default null,
  p_actor      uuid default null,
  p_ip         text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_actor is not null
     and auth.uid() is not null
     and p_actor is distinct from auth.uid() then
    raise exception 'An audit entry can only be filed against the signed-in user.'
      using errcode = '42501';
  end if;

  insert into public.security_events (actor_id, event_type, fn, detail, ip)
  values (
    coalesce(p_actor, auth.uid()),
    left(coalesce(p_event_type, 'unknown'), 64),
    left(p_fn, 128),
    left(p_detail, 1000),
    left(p_ip, 64)
  );
end;
$$;

-- create or replace preserves the ACL, so these only re-state the state 0020 and
-- 0050 already left behind. Kept explicit so the grant is readable in one place.
revoke all on function public.log_security_event(text, text, text, uuid, text) from public, anon;
grant execute on function public.log_security_event(text, text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Pin the last unpinned SECURITY DEFINER search_path.
-- ---------------------------------------------------------------------------
-- ai_rate_check was the only definer function in the schema still on
-- `set search_path = public` (0018_ai_rate_limit.sql:20) while referencing
-- ai_rate_limit unqualified. Postgres searches pg_temp FIRST for relation names
-- when pg_temp is not named in the path, so a session holding a temp table called
-- ai_rate_limit would shadow the real one and the limiter would return true
-- forever — unlimited spend on the operator's Anthropic key.
--
-- Reachability, stated honestly: this needs a DIRECT Postgres connection. PostgREST
-- only executes predefined RPCs and gives no way to CREATE TEMP TABLE, so it was
-- never exploitable with the anon key. Fixed because it is one line and because
-- "every definer function pins ''" is a rule worth being able to state without an
-- exception.
--
-- Body is otherwise byte-identical to 0018. `ai_rate_limit.count` in the ON
-- CONFLICT DO UPDATE clause stays unqualified on purpose — that is the alias for
-- the insert target, not a schema lookup.
create or replace function public.ai_rate_check(p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid        := auth.uid();
  w   timestamptz := date_bin(make_interval(secs => p_window_seconds), now(), timestamptz 'epoch');
  c   integer;
begin
  if uid is null then
    return false; -- unauthenticated → deny
  end if;
  insert into public.ai_rate_limit (user_id, window_start, count)
  values (uid, w, 1)
  on conflict (user_id, window_start) do update
    set count = ai_rate_limit.count + 1
  returning count into c;
  -- opportunistic GC of this user's stale windows (keeps the table tiny)
  delete from public.ai_rate_limit where user_id = uid and window_start < now() - interval '2 hours';
  return c <= p_limit;
end;
$$;

revoke all on function public.ai_rate_check(integer, integer) from public, anon;
grant execute on function public.ai_rate_check(integer, integer) to authenticated;
