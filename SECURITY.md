# Security model & deployment checklist

This app is a React (Create React App) front end on Supabase (Postgres + Auth +
Storage + Edge Functions). Security is enforced in four layers; the browser is
never trusted.

## 1. Authentication (Supabase Auth / GoTrue)

- **Password hashing** is handled by Supabase (bcrypt). The app never sees or
  stores raw passwords.
- **Password policy** (`supabase/config.toml`): minimum length **10** and
  `lower_upper_letters_digits` complexity. Mirrored client-side in
  `src/pages/Login.js` for instant feedback (server is the source of truth).
- **Email verification** is **on** (`enable_confirmations = true`). ⚠️ The live
  project needs a production SMTP sender (below) or real sign-ups can't confirm.
- **Sessions expire**: 1h access tokens, refresh-token rotation, plus a 24h hard
  timebox and 8h inactivity timeout (`[auth.sessions]`).
- **Password reset / OTP tokens expire** (`otp_expiry = 3600`).
- **Secure password change** requires recent re-authentication.
- **Login/signup rate limiting** is enforced by Supabase per-IP
  (`[auth.rate_limit]`). Add a captcha (below) for stronger bot protection.
- **Secrets**: the browser only ever receives the URL + **anon** key, which is
  safe because it is RLS-protected. No service-role key or API key is in `src/`,
  the build, or git history.

## 2. Authorization — RLS everywhere (IDOR prevention)

Every table is owner-scoped via Row Level Security: `owner_id = auth.uid()` for
all reads/writes (`0001_init.sql` and each later table's migration). This is what
prevents insecure direct object references — even though the data layer queries by
id, the database refuses rows the caller doesn't own. Reporting **views** run with
`security_invoker = on` (`0017`) so RLS applies through them too. Storage objects
are scoped to each user's `<uid>/` folder (`0003`).

The `apply_due_renewals()` SECURITY DEFINER job is hardened (`0020`): pinned
`search_path`, and `EXECUTE` revoked from `anon`/`authenticated` so only the
scheduler can run it.

## 3. Input validation & abuse protection

- **DB CHECK constraints** (`0020`) bound every user-writable text/number column
  (lengths, non-negative money, sane years, email format) — enforced for *every*
  writer, regardless of client.
- **No SQL injection**: all queries go through PostgREST / the Supabase query
  builder (parameterized). The NL portfolio search maps to an **allowlist** of
  fields/operators, never raw SQL.
- **No command injection / XSS**: no subprocess calls in functions; React escapes
  output and there is no `dangerouslySetInnerHTML`/`eval`.
- **File uploads**: the `lease-documents` bucket is restricted to PDF/PNG/JPEG/
  WEBP/GIF with a 25 MiB cap (`0020`), enforced server-side; `src/lib/api.js`
  validates type+size client-side too.
- **AI endpoint abuse / cost protection**: every AI Edge Function requires a real
  authenticated user and is **per-user rate limited** (`0018`/`0019`,
  `_shared/ratelimit.ts`); the public anon key alone gets a clean 429. Documents
  are passed to the model as data inside tags (prompt-injection hardening).
- **Cron lockdown**: `send-reminders` is not a user endpoint — it requires the
  `CRON_SECRET` header (constant-time checked) and runs with `verify_jwt = false`.

## 4. Logging / detection

- Supabase logs auth attempts in `auth.audit_log_entries` and Edge Function
  errors in the Functions logs.
- App-level `security_events` table (`0020`) records denials, rate-limit hits and
  errors via `log_security_event()`; `send-reminders` writes unauthorized-call
  attempts there. Alert on spikes in `security_events` / `ai_rate_limit`.

---

## Deployment checklist (run against the live project)

> These touch your live, billable Supabase project (ref `awgrjmbcghdjgnqeiqkt`).
> Review the diffs first. Nothing here has been deployed for you.

1. **Apply migrations** (adds rate limiting, constraints, storage limits, audit log,
   renewal hardening):
   ```bash
   supabase db push
   ```
2. **Set Edge Function secrets** (server-only — never in `.env.local`):
   ```bash
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
   supabase secrets set RESEND_API_KEY=...                       # if using reminder email
   supabase secrets set REMINDER_FROM_EMAIL=reminders@yourdomain.com
   supabase secrets set CRON_SECRET="$(openssl rand -hex 32)"    # save this value
   supabase secrets set ALLOWED_ORIGIN=https://your-app-domain   # CORS lockdown
   ```
3. **Deploy functions:**
   ```bash
   supabase functions deploy
   ```
4. **Auth settings on the live project** — set these in the Dashboard
   (Authentication), since `config.toml` only drives local dev (or run
   `supabase config push` if your CLI supports it):
   - Confirm email **on**; configure a production **SMTP** sender (required for #1
     to be usable).
   - Minimum password length **10**, complexity on.
   - Session timebox 24h / inactivity 8h.
   - **Enable "Prevent use of leaked passwords"** (HIBP) — recommended.
   - **Enable a captcha** (hCaptcha/Turnstile) for sign-in/sign-up, and render the
     widget in `Login.js`, for real bot protection. *(Not yet wired in the UI.)*
   - Consider enabling **MFA (TOTP)**.
5. **Restrict direct database access from the public internet**: Dashboard →
   Settings → Database → **Network Restrictions** (allow only your egress
   CIDRs / Supabase services), and prefer the connection **pooler**. DB SSL is
   enforced via `[db.ssl_enforcement]`.
6. **Enforce HTTPS** on the front end host (Vercel/Netlify/etc. do this by
   default; disable plain-HTTP and add HSTS).
7. **Schedule the reminder job** with the secret header, e.g. via pg_cron + pg_net:
   ```sql
   select cron.schedule('send-reminders', '0 13 * * *', $$
     select net.http_post(
       url    => 'https://awgrjmbcghdjgnqeiqkt.supabase.co/functions/v1/send-reminders',
       headers => jsonb_build_object('x-cron-secret', '<CRON_SECRET>')
     );
   $$);
   ```
8. **Logging/alerting**: enable a Log Drain and alert on `security_events`
   growth and `auth.audit_log_entries` failed-login spikes.

## Residual recommendations (not done here)

- Wire the captcha widget into the login UI (step 4).
- Have the AI Edge Functions also call `log_security_event()` on auth/validation
  failures (the table + helper exist; only `send-reminders` writes to it today).
- Tighten the AI functions' catch blocks to return generic messages (they
  currently surface upstream error text — low severity, no secrets exposed).
