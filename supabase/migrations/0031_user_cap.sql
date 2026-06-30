-- ---------------------------------------------------------------------------
-- Account cap (private beta backstop)
--
-- During the test run we only want a small, fixed number of logins. This trigger
-- rejects any new account once the cap is reached — a hard backstop that holds
-- even if public sign-up is accidentally left on in Supabase. It is the reliable
-- enforcement; hiding the "Sign up" link (Login.js) and Supabase's enable_signup
-- setting are the softer front-door locks layered on top.
--
-- HOW TO CHANGE IT LATER (all quick + fully reversible, no data loss):
--   • Add more people  → change `v_cap` below and re-run this CREATE OR REPLACE
--                         FUNCTION statement (e.g. 2 → 5).
--   • Open to public   → drop the cap entirely:
--                           drop trigger trg_enforce_user_cap on auth.users;
--                           drop function public.enforce_user_cap();
--                         then re-enable sign-up (Login.js SIGNUP_OPEN = true and
--                         Supabase Auth → enable_signup = true).
--
-- Note: the cap counts EXISTING accounts, so make sure only the intended people
-- exist before it fills up — delete any leftover test accounts in Supabase first.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_user_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_cap int := 2;  -- <<< maximum number of accounts. Bump this to add people.
begin
  if (select count(*) from auth.users) >= v_cap then
    raise exception 'Account limit reached (% accounts). Sign-ups are closed during the beta.', v_cap
      using errcode = 'check_violation';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_enforce_user_cap on auth.users;
create trigger trg_enforce_user_cap
  before insert on auth.users
  for each row execute function public.enforce_user_cap();
