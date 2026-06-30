-- Per-user rate limiting for the AI endpoints (cost protection against a malicious
-- or runaway caller burning the Anthropic key). A fixed-window counter keyed by
-- (user, window_start). ai_rate_check() bumps and checks atomically; it is
-- SECURITY DEFINER so it can write to this table even though the table has RLS
-- enabled with NO policy — the table is therefore unreachable via the public REST
-- API, and only this function can read/write it.
create table if not exists ai_rate_limit (
  user_id      uuid        not null,
  window_start timestamptz not null,
  count        integer     not null default 0,
  primary key (user_id, window_start)
);
alter table ai_rate_limit enable row level security;
-- No policy on purpose: deny all direct API access; only ai_rate_check (definer) touches it.

create or replace function ai_rate_check(p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid        := auth.uid();
  w   timestamptz := date_bin(make_interval(secs => p_window_seconds), now(), timestamptz 'epoch');
  c   integer;
begin
  if uid is null then
    return false; -- unauthenticated → deny
  end if;
  insert into ai_rate_limit (user_id, window_start, count)
  values (uid, w, 1)
  on conflict (user_id, window_start) do update
    set count = ai_rate_limit.count + 1
  returning count into c;
  -- opportunistic GC of this user's stale windows (keeps the table tiny)
  delete from ai_rate_limit where user_id = uid and window_start < now() - interval '2 hours';
  return c <= p_limit;
end;
$$;

-- Only authenticated callers may invoke it (the AI endpoints all require a JWT).
revoke all on function ai_rate_check(integer, integer) from public;
grant execute on function ai_rate_check(integer, integer) to authenticated;
