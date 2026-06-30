-- Security hardening: run the reporting views with the QUERYING user's privileges
-- (security_invoker) so Row-Level Security on the underlying tables (leases,
-- properties, expense_records) applies to queries made THROUGH the views.
--
-- Why this matters: by default a Postgres view executes as its OWNER (the admin
-- role that created it), which BYPASSES RLS. Because these views live in the
-- public schema, Supabase exposes them via the auto-generated REST API — so
-- without security_invoker, any authenticated user could read every owner's
-- financials (revenue, NOI, rent, tenant shares) straight through the views,
-- regardless of the RLS policies on the base tables.
--
-- Requires Postgres 15+ (this project is on 17). The views have no dependents.
alter view v_property_totals set (security_invoker = on);
alter view v_tenant_shares  set (security_invoker = on);
