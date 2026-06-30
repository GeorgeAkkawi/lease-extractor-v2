-- Let the anon role CALL the limiter too. Combined with ai_rate_check returning
-- false when auth.uid() is null, this means an unauthenticated caller hitting an
-- AI endpoint directly with the public key is blocked (the helper returns 429)
-- instead of slipping through on a permission-denied error (fail-open). The
-- function is SECURITY DEFINER, so anon still cannot read/write the table — it can
-- only ask "am I allowed?", and for a null user the answer is always no.
grant execute on function ai_rate_check(integer, integer) to anon;
