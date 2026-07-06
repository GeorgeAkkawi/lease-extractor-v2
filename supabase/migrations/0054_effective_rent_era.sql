-- 0054_effective_rent_era.sql
-- Fix: the Overview "Annual rent roll" card (and the property Financials revenue/NOI)
-- disagreed with the Leases-page property card for a lease that had been renewed.
--
-- Both views ultimately read effective_rent(lease, year). The old function ALWAYS
-- preferred the latest APPLIED escalation over the lease's base_rent:
--
--     coalesce( <latest applied step .effective_date <= Dec 31 of year>, base_rent )
--
-- But confirming a renewal option (rollLeaseIntoRenewal, api.js) writes the new rent
-- straight onto leases.base_rent WITHOUT adding a matching applied escalation row. So a
-- renewed lease keeps a stale ledger (its last applied step is the pre-renewal rent),
-- and effective_rent kept returning that stale figure forever — while the Leases-page
-- card reads raw base_rent and showed the true (higher) rent. Five Points Wings read
-- $34,225 in the rent roll vs $41,403 on the card: a $7,178 gap, portfolio-wide.
--
-- Root-cause fix: make effective_rent ERA-AWARE. base_rent is the CURRENT rent (kept
-- live by applyDueEscalations, renewals, and manual edits), so it is authoritative for
-- the current era. The ledger is only consulted for a HISTORICAL year — one that has an
-- applied step dated AFTER it, proving a later rent superseded it.
--
--   • Historical year (an applied step exists with effective_date > Dec 31 of the year):
--       answer from the ledger — latest applied step <= Dec 31, else base_rent.
--   • Current era (no applied step dated after the year): base_rent wins.
--
-- For a healthy lease (ledger in sync with base_rent) this returns the IDENTICAL value
-- to the old function, so no other property/tenant number shifts. Non-destructive
-- create-or-replace of the function only — same signature, so v_property_totals and
-- v_tenant_shares pick it up unchanged (no view recreation, grants preserved).

create or replace function effective_rent(p_lease_id uuid, p_year int)
returns numeric language sql stable as $$
  select case
    -- Historical year: a later applied step supersedes it → read the ledger.
    when exists (
      select 1 from rent_escalations e
       where e.lease_id = p_lease_id
         and e.status = 'applied'
         and e.effective_date > make_date(p_year, 12, 31)
    )
    then coalesce(
      (select e.new_base_rent
         from rent_escalations e
        where e.lease_id = p_lease_id
          and e.status = 'applied'
          and e.effective_date <= make_date(p_year, 12, 31)
        order by e.effective_date desc
        limit 1),
      (select l.base_rent from leases l where l.id = p_lease_id)
    )
    -- Current era: base_rent is the live, authoritative rent.
    else (select l.base_rent from leases l where l.id = p_lease_id)
  end;
$$;
