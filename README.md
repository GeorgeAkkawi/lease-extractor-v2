# Lease Extractor V2 — commercial lease & financials dashboard

A property-management app for commercial landlords. One Corporation → Property →
Tenant data model drives everything:

1. **Leases** — square footage, base rent, escalations, abatements, renewals,
   addendums/riders, termination, tenant insurance. Add a lease manually or upload
   the document (PDF / Word / scan / photo) and let AI fill the fields — with
   confidence scores, source clauses, and an analyst brief you review before saving.
2. **Financials** — revenue is computed from the leases (year-aware, era-aware
   `effective_rent`); you enter taxes / CAM / roof and the app computes building-SF
   $/SF rates, per-tenant tax/CAM shares, invoices, a monthly rent tracker, AR
   aging, and history.
3. **Overview & alerts** — rent roll, occupancy, receivables, expirations, and
   actionable reminders (escalations, renewals, insurance/contract expiry, overdue
   invoices), each with a ready-to-send email.
4. **Ask AI** — natural-language questions over the account's own records
   (tenants, insurance, balances), answered from a compact facts-only summary and
   cached so repeats are free.

**Cost principle:** all arithmetic (revenue, PSF, proration, escalation and
abatement amounts, invoices) runs in plain JS/SQL — the two are mirrored so they
agree to the cent. The Claude API is used only for language tasks: document
extraction (Haiku form-fill + a Sonnet "analyst read"), per-document Q&A, and the
trends narrative. The API key lives server-side only (Edge Functions).

## Stack
- React 19 · react-router-dom 7 · @tanstack/react-query 5 · recharts
- **Vite 7** (build/dev) + **Vitest 3** (tests) — migrated off Create React App
- Supabase: Postgres (RLS everywhere, SQL views for the money math) + Auth
  (TOTP 2FA with server-side aal2 enforcement) + Storage + Edge Functions (Deno)
- Anthropic Claude API (Edge Functions only)
- Deployed as static assets on a Cloudflare Worker (`npx wrangler deploy`)

## Setup

### 1. Supabase project
- Create a project at supabase.com and link it (`supabase link`).
- Apply the migrations in `supabase/migrations/` in order: `supabase db push`.
  They create the schema, computed views, RLS policies, reminder triggers, cron
  jobs, and the private `lease-documents` storage bucket.
- Deploy the edge functions: `supabase functions deploy`
  (`send-reminders` and `health-check` are cron jobs — deploy with
  `--no-verify-jwt`; they authorize via the `x-cron-secret` header instead).
- Set the server-side secrets:
```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...      # AI extraction / Q&A
supabase secrets set RESEND_API_KEY=...                # owner reminder emails
supabase secrets set REMINDER_FROM_EMAIL=you@domain.com
supabase secrets set CRON_SECRET=<long-random-string>  # authorizes the cron calls
supabase secrets set ALLOWED_ORIGINS=https://your-app-domain
supabase secrets set ADMIN_ALERT_EMAIL=you@domain.com  # health-check alerts
```

### 2. Frontend env
```bash
cp .env.example .env.local
# fill in REACT_APP_SUPABASE_URL and REACT_APP_SUPABASE_ANON_KEY
npm install
npm start          # Vite dev server on :3000
```
With no `.env.local` the app runs in **demo mode** — an in-memory mock with seeded
data, fully clickable, no backend and no AI spend.

### 3. Build, test, deploy
```bash
npm test           # vitest run — the suite mirrors the SQL money math
npm run build      # vite build → ./build
npx wrangler deploy
```
`main` is the deploy branch; deploys happen locally via wrangler (no CI). See
`CLAUDE.md` for the standing instructions and the dated deployment log.

## How it fits together
- Leases are the single source of truth. The Financials pages read the
  `v_property_totals` / `v_tenant_shares` / `v_invoice_balances` views, so editing
  a lease (or an escalation applying) cascades to revenue, PSF, per-tenant shares,
  and receivables with no re-entry.
- Saving a lease/escalation/renewal regenerates `key_dates` + `reminders`
  (1 month / 2 weeks / 1 week ahead) via DB triggers; nightly pg_cron jobs apply
  due escalations, open renewal-decision prompts, send owner reminder emails, and
  run the operator health check.
- "Close year" on the History page snapshots a year so later edits don't rewrite
  the historical record; the Trends chart + AI narrative read those snapshots.

## Available scripts
`npm start` · `npm run build` · `npm test` (`npm run test:watch` for watch mode)
