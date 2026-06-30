-- 0023_invoices_payments.sql
-- Phase B: rent collection / AR. Until now invoices were generated and thrown away
-- (no record, no paid/unpaid, no "who owes what"). This persists each invoice and
-- records payments against it, so the landlord can track receivables.
--
-- Design: an invoice stores a snapshot of the year's charges (from v_tenant_shares,
-- via the same figures InvoiceButton already computes) plus a landlord-controlled
-- lifecycle status (draft / sent / void). Payments are separate rows (partial
-- payments supported). The paid/partial/overdue state is DERIVED in v_invoice_balances
-- from the payments + due date — never stored stale. Late fees are intentionally out
-- of v1 (add later). Annual invoices match the existing annual financials model.

create table invoices (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  lease_id         uuid not null references leases (id) on delete cascade,
  property_id      uuid not null references properties (id) on delete cascade,
  year             int  not null,
  issue_date       date not null default current_date,
  due_date         date,
  status           text not null default 'sent' check (status in ('draft', 'sent', 'void')),
  base_rent_annual numeric not null default 0,
  cam_annual       numeric not null default 0,
  tax_annual       numeric not null default 0,
  roof_annual      numeric not null default 0,
  total_amount     numeric not null default 0,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint ck_inv_amounts check (
    base_rent_annual >= 0 and cam_annual >= 0 and tax_annual >= 0 and roof_annual >= 0
    and total_amount >= 0 and total_amount < 1e12),
  constraint ck_inv_year  check (year between 1900 and 2200),
  constraint ck_inv_notes check (notes is null or char_length(notes) <= 5000)
);
create index on invoices (lease_id);
create index on invoices (property_id, year);

create table payments (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  invoice_id uuid not null references invoices (id) on delete cascade,
  lease_id   uuid not null references leases (id) on delete cascade,
  amount     numeric not null check (amount >= 0 and amount < 1e12),
  paid_date  date not null default current_date,
  method     text check (method is null or method in ('check', 'ach', 'wire', 'card', 'cash', 'other')),
  note       text,
  created_at timestamptz not null default now(),
  constraint ck_pay_note check (note is null or char_length(note) <= 2000)
);
create index on payments (invoice_id);
create index on payments (lease_id);

create trigger trg_invoices_updated before update on invoices
  for each row execute function set_updated_at();

alter table invoices enable row level security;
alter table payments enable row level security;
do $$ begin
  create policy owner_all on invoices for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy owner_all on payments for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Derived balance + display status. paid/partial/overdue are computed, never stored.
create view v_invoice_balances as
select
  i.*,
  coalesce(p.amount_paid, 0)                  as amount_paid,
  (i.total_amount - coalesce(p.amount_paid, 0)) as balance,
  case
    when i.status = 'void'  then 'void'
    when i.status = 'draft' then 'draft'
    when (i.total_amount - coalesce(p.amount_paid, 0)) <= 0 then 'paid'
    when coalesce(p.amount_paid, 0) > 0 then 'partial'
    when i.due_date is not null and i.due_date < current_date then 'overdue'
    else 'sent'
  end as display_status
from invoices i
left join (
  select invoice_id, sum(amount) as amount_paid from payments group by invoice_id
) p on p.invoice_id = i.id;

-- Run the view with the querying user's privileges so the invoices/payments RLS
-- applies through it (same hardening as v_property_totals/v_tenant_shares, 0017).
alter view v_invoice_balances set (security_invoker = on);
