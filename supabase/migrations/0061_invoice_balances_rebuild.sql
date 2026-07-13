-- 0061_invoice_balances_rebuild.sql
-- Two view refreshes, both non-destructive. No table/column/data changes.
--
--   1. REBUILD v_invoice_balances so it picks up the invoice columns added after its
--      last rebuild. The view selects `i.*`, and Postgres FREEZES that column list at
--      CREATE time — later `alter table invoices add column …` does NOT appear in the
--      view until it's recreated. Since the 0055 rebuild, two columns were added to
--      invoices and never surfaced through the view:
--        • kind                  (0060 — 'annual' | 'reconciliation')
--        • overdue_notice_bucket (0057 — the send-reminders overdue-email dedupe stamp)
--      Consequences of the drift (all live-confirmed): the app's isAnnualInvoice()
--      always read undefined → a lease with a reconciliation invoice showed "No rent on
--      file" in its monthly tracker; the InvoicesPanel "Reconciliation" badge never
--      rendered; and send-reminders' overdue sweep selected a non-existent column →
--      400'd every night. Recreating with the same body fixes all three at once — the
--      fresh `i.*` expansion includes both columns (and any future ones). Body is
--      otherwise byte-identical to 0055 (the ±5¢ dust clamp is preserved).
--
--   2. APPEND lease_start to v_tenant_shares so the rent roll + draft-invoice can build
--      term-aware monthly schedules (prorate a mid-year lease start, know which months
--      a tenant actually owes) without a second query per tenant. create-or-replace can
--      only ADD trailing columns, so lease_start is appended after the 0060 estimate
--      columns — columns 1-21 keep their exact 0060 order. Body otherwise identical to
--      0060; security_invoker re-asserted.

-- 1) v_invoice_balances — rebuild to surface kind + overdue_notice_bucket ------
-- DROP + CREATE (not create-or-replace): a changed `i.*` column set makes REPLACE
-- refuse. Nothing depends on this view (leaf read by the app), so the drop is safe;
-- grants + security_invoker are re-established explicitly below.
drop view if exists v_invoice_balances;
create view v_invoice_balances as
select
  i.*,
  coalesce(p.amount_paid, 0) as amount_paid,
  case when abs(i.total_amount - coalesce(p.amount_paid, 0)) <= 0.05
       then 0
       else i.total_amount - coalesce(p.amount_paid, 0)
  end as balance,
  case
    when i.status = 'void'  then 'void'
    when i.status = 'draft' then 'draft'
    when (i.total_amount - coalesce(p.amount_paid, 0)) <= 0.05 then 'paid'
    when coalesce(p.amount_paid, 0) > 0 then 'partial'
    when i.due_date is not null and i.due_date < current_date then 'overdue'
    else 'sent'
  end as display_status
from invoices i
left join (
  select invoice_id, sum(amount) as amount_paid from payments group by invoice_id
) p on p.invoice_id = i.id;

alter view v_invoice_balances set (security_invoker = on);
grant select on v_invoice_balances to authenticated, service_role;

-- 2) v_tenant_shares — append lease_start (columns 1-21 unchanged from 0060) ----
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
  coalesce(l.share_override_pct, case when coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf) end) as share_pct,
  coalesce(l.share_override_pct, case when coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf) end) * coalesce(er.taxes_total, 0) as tax_amount,
  coalesce(l.share_override_pct, case when coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf) end) * coalesce(er.cam_total, 0)   as cam_amount,
  case when l.roof_responsible and coalesce(nullif(p.building_sf, 0), pt.total_sf) > 0 then coalesce(er.roof_total, 0) * (l.square_footage / coalesce(nullif(p.building_sf, 0), pt.total_sf)) else 0 end as roof_amt,
  l.tenant_email_2,
  abatement_credit(l.id, pr.year) as abatement_amount,
  l.is_active,
  l.lease_termination_date,
  l.premises_address,
  l.est_cam_annual,
  l.est_tax_annual,
  l.est_roof_annual,
  l.lease_start
from leases l
join periods pr on pr.property_id = l.property_id
join properties p on p.id = l.property_id
left join expense_records er on er.property_id = l.property_id and er.year = pr.year
left join (select property_id, coalesce(sum(square_footage), 0) total_sf from leases where is_active group by property_id) pt
  on pt.property_id = l.property_id;
alter view v_tenant_shares set (security_invoker = on);
