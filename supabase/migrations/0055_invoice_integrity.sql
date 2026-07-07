-- 0055_invoice_integrity.sql
-- Billing-integrity hardening (review items C-1 / C-2, 2026-07-07):
--
--   1. AT MOST ONE LIVE INVOICE PER (lease, year). Nothing enforced this, so a second
--      "Save to receivables" click — or the monthly tracker auto-creating the year's
--      invoice while the invoice modal was open — produced TWO live invoices for the
--      same tenant + fiscal year, and Outstanding AR doubled (reproduced in demo:
--      $98,500 → $208,300). A partial unique index makes the duplicate impossible;
--      the app's ensureInvoice/upsertYearInvoice treat the 23505 as "use the existing
--      invoice". Voided invoices are excluded, so re-issuing after a void still works.
--
--   2. ROUNDING DUST READS AS SETTLED. The monthly tracker bills round2(total/12) per
--      month, so 12 payments can sum a few cents shy of the invoice total
--      ($98,500/12 → $8,208.33 ×12 = $98,499.96) and a fully-paid year read "partial"
--      forever with a 4¢ balance. The JS schedule is now penny-true (the last month
--      absorbs the remainder), and as a belt-and-braces layer the view clamps a
--      balance within ±5¢ to zero — rounding dust, not real debt. A genuine balance
--      (> 5¢ either way) is untouched.
--
-- Order matters: void any pre-existing duplicates FIRST (keeping the invoice with the
-- most money paid against it, then the oldest), or the unique index cannot be created.
-- Voiding is reversible (status flip only; payments stay attached) — no data is lost.

-- 1a) Void duplicate live invoices per (lease, year), keeping the most-paid/oldest one.
with paid as (
  select invoice_id, coalesce(sum(amount), 0) as total
    from public.payments group by invoice_id
), ranked as (
  select i.id,
         row_number() over (
           partition by i.lease_id, i.year
           order by coalesce(p.total, 0) desc, i.created_at asc, i.id asc
         ) as rn
    from public.invoices i
    left join paid p on p.invoice_id = i.id
   where i.status <> 'void'
)
update public.invoices
   set status = 'void',
       notes = coalesce(notes || ' · ', '') || 'Voided as duplicate (0055)'
 where id in (select id from ranked where rn > 1);

-- 1b) The guarantee: one live (non-void) invoice per lease + fiscal year.
create unique index if not exists invoices_one_live_per_lease_year
  on public.invoices (lease_id, year)
  where status <> 'void';

-- 2) v_invoice_balances: same shape as 0023, plus the ±5¢ dust clamp on balance /
--    paid status. security_invoker re-asserted so RLS still applies through the view.
create or replace view v_invoice_balances as
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
