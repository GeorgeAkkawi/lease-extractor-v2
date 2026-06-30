# PropManager — commercial lease & financials dashboard

A property-management app for tracking leases and the financials that build off
them. Two pages share the same Corporation → Property → Tenant data:

1. **Leases** — square footage, base rent, escalations, termination, terms,
   renewals. Add manually or upload a lease (PDF / scan / photo / handwritten)
   and let AI fill the fields (with confidence scores + source clauses you
   review before saving).
2. **Financials** — revenue is summed from the leases automatically; you enter
   taxes / CAM / roof and the app computes PSF rates (roof excluded), per-tenant
   tax/CAM shares, invoices, history, and trends.

**Cost principle:** all arithmetic (revenue, PSF, proration, escalation amounts)
runs in plain JS/SQL. The Claude API is used only for language tasks —
extraction, invoice prose, the trends narrative, and translating natural-language
search into a safe filter. Cheap model (Haiku) for prose/search, Sonnet for
document extraction.

## Stack
- React 19 (Create React App) · react-router-dom · @tanstack/react-query · recharts
- Supabase: Postgres + Auth + Storage + Edge Functions
- Anthropic Claude API (called only from Edge Functions; key stays server-side)

## Setup

### 1. Supabase project
- Create a project at supabase.com.
- Run the migrations in `supabase/migrations/` in order (SQL editor, or
  `supabase db push` with the CLI): `0001_init`, `0002_reminders`, `0003_storage`.
  These create the schema, computed views, RLS, the reminder triggers, and the
  private `lease-documents` storage bucket.

### 2. Frontend env
```bash
cp .env.example .env.local
# fill in REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY
npm install
npm start
```

### 3. Edge Functions (AI + reminders)
Set secrets, then deploy:
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set RESEND_API_KEY=...            # for reminder emails (optional)
supabase secrets set REMINDER_FROM_EMAIL=you@domain.com

supabase functions deploy extract-lease
supabase functions deploy draft-invoice
supabase functions deploy trends-narrative
supabase functions deploy query-portfolio
supabase functions deploy send-reminders --no-verify-jwt   # cron-invoked
```

### 4. Schedule daily reminders
In the SQL editor, schedule `send-reminders` with pg_cron (see the note at the
bottom of `supabase/migrations/0002_reminders.sql`).

## How it fits together
- Page 1 leases are the single source of truth. Page 2 reads the
  `v_property_totals` / `v_tenant_shares` views, so editing a lease (or accepting
  a rent escalation) cascades to revenue, PSF, and per-tenant figures with no
  re-entry.
- Saving a lease/escalation/renewal regenerates `key_dates` + `reminders`
  (1 month / 2 weeks / 1 week before escalations & terminations) via DB triggers.
- "Close year" on the History page snapshots a year so later edits don't rewrite
  the historical record; the Trends page charts those snapshots and can generate
  an AI year-over-year summary.

## Available scripts
`npm start` · `npm run build` · `npm test`
