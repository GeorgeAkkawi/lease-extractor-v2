-- 0067_expense_line_kinds.sql
-- Property taxes become itemized, and a CAM line can be priced off base rent.
--
-- Additive / non-destructive: two ADD COLUMNs (one with a default, one nullable)
-- plus two named CHECK constraints. No rows change, no view is touched, safe to
-- re-run.
--
-- Rule-#7 check (views selecting X.* from an altered table): no view selects
-- cam_line_items.* — CAM/tax totals live on expense_records, maintained by the
-- client-side re-sum — so no view rebuild is needed. (Same finding as 0064.)
--
--   • cam_line_items.kind — 'cam' (default, every existing row) is the itemized
--     CAM list exactly as today. 'tax' is the same list shape for PROPERTY TAXES:
--     George's bank statements pay taxes several times a year, and each payment
--     should read as its own line rather than disappearing into one running
--     total. Tax rows re-sum into expense_records.taxes_total the way CAM rows
--     re-sum into cam_total, so every downstream figure (PSF, tenant shares,
--     views, invoices) keeps working untouched.
--   • cam_line_items.rent_pct — set when a line is priced as a PERCENTAGE of the
--     property's annual base rent (a management fee). The dollar `amount` is
--     still what bills; rent_pct records how it was derived, so the row can say
--     "5% of $302,537.36 base rent" and follow the rent when it changes.

alter table public.cam_line_items
  add column if not exists kind text not null default 'cam',
  add column if not exists rent_pct numeric;

do $$ begin
  alter table public.cam_line_items drop constraint if exists ck_expense_line_kind;
  alter table public.cam_line_items
    add constraint ck_expense_line_kind check (kind in ('cam', 'tax'));

  alter table public.cam_line_items drop constraint if exists ck_expense_line_rent_pct;
  alter table public.cam_line_items
    add constraint ck_expense_line_rent_pct
    check (rent_pct is null or (rent_pct >= 0 and rent_pct <= 100));
end $$;

create index if not exists cam_line_items_property_year_kind_idx
  on public.cam_line_items (property_id, year, kind);
