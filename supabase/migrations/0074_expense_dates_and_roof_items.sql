-- 0074_expense_dates_and_roof_items.sql
-- Every expense line can say the day it was paid, and the roof stops being one flat number.
--
-- Additive / non-destructive: one nullable ADD COLUMN plus a widened CHECK. No rows
-- change, no total moves, no view is touched, safe to re-run.
--
-- Rule-#7 check (views selecting X.* from an altered table): no view selects
-- cam_line_items.* — CAM / tax / roof totals live on expense_records, maintained by
-- the client-side re-sum — so no view rebuild is needed. Same finding as 0064 and 0067,
-- re-verified against the current schema rather than inherited from them.
--
--   • cam_line_items.paid_date — the day the money actually left the account. NULLABLE
--     on purpose and NOT backfilled: an expense typed by hand legitimately has no date,
--     and inventing one (Dec 31, say) would be a lie that looks like a real date
--     forever. Anything that reads dates has to state how many dollars it could not
--     date. The bank importer has always known each line's real date — statementMatch
--     derives the fiscal year FROM it — and then discarded it; this is the column it
--     was missing. Until now `year int` was the only time an expense had, so there was
--     no month, no trend, and no answer to "why was March so expensive".
--
--   • kind gains 'roof' — the third itemized list, in the shape 'tax' took in 0067.
--     A roof is replaced once and repaired several times; one accumulating figure
--     hides which payment was which. Roof rows re-sum into expense_records.roof_total
--     exactly as tax rows re-sum into taxes_total, so every downstream figure (roof
--     PSF, the recovered/absorbed split in v_property_totals, roof-responsible tenant
--     shares, invoices) keeps working untouched.
--
--     ⚠ The hazard this shares with 0067, and the reason carryFlatRoofIntoItems exists
--     in api.js: a property whose roof was entered as one flat figure would, on the
--     first itemized instalment, re-sum the year DOWN to that instalment — and the roof
--     bills back at 100% to roof-responsible tenants, so the under-bill would be
--     immediate and silent. The flat figure is carried into its own line before
--     anything else is added. That is a client-side guarantee; this migration only
--     makes the third list legal.

alter table public.cam_line_items
  add column if not exists paid_date date;

do $$ begin
  alter table public.cam_line_items drop constraint if exists ck_expense_line_kind;
  alter table public.cam_line_items
    add constraint ck_expense_line_kind check (kind in ('cam', 'tax', 'roof'));
end $$;
