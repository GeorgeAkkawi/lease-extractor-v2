// Scheduled (daily via pg_cron) OPERATOR-ONLY backend health check. It gathers
// read-only metrics through public.collect_health_metrics(), scores them, records
// one row in public.health_reports (durable history), and — only when something
// needs attention — emails the single operator address (ADMIN_ALERT_EMAIL).
//
// SECURITY: this is NOT a user endpoint. It is deployed with verify_jwt = false
// (see config.toml) and authorized ONLY by a shared secret: the caller must send
// `x-cron-secret: <CRON_SECRET>` (constant-time compared). Without it (or if
// CRON_SECRET is unset) it refuses to run and records the attempt in
// security_events. It NEVER reads a tenant/user email and NEVER writes to the
// customer-facing notifications table — the only outbound contact is to
// ADMIN_ALERT_EMAIL.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const CRON_SECRET = Deno.env.get('CRON_SECRET');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const ADMIN_EMAIL = Deno.env.get('ADMIN_ALERT_EMAIL');
const FROM_EMAIL = Deno.env.get('HEALTH_FROM_EMAIL') ?? Deno.env.get('REMINDER_FROM_EMAIL') ?? 'alerts@example.com';

// Plan limits + thresholds — env-overridable so they can match the real plan.
const envNum = (k: string, d: number) => Number(Deno.env.get(k) ?? d);
const DB_LIMIT_MB = envNum('DB_LIMIT_MB', 500);          // Free ≈ 500 MB · Pro ≈ 8192
const STORAGE_LIMIT_MB = envNum('STORAGE_LIMIT_MB', 1024); // Free ≈ 1 GB
const NEW_USERS_WARN = envNum('NEW_USERS_WARN', 50);
const AI_CALLS_WARN = envNum('AI_CALLS_WARN', 1000);

const MB = 1024 * 1024;
type Sev = 'ok' | 'warn' | 'critical';
type Finding = { area: string; severity: Sev; message: string };
const RANK: Record<Sev, number> = { ok: 0, warn: 1, critical: 2 };

// Constant-time comparison so the secret check doesn't leak length/content via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function logEvent(event_type: string, detail: string, ip: string) {
  try {
    await supabase.rpc('log_security_event', {
      p_event_type: event_type,
      p_fn: 'health-check',
      p_detail: detail.slice(0, 1000),
      p_ip: ip || null,
    });
  } catch (_) {
    // never let audit logging break the job
  }
}

Deno.serve(async (req) => {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();

  // --- Authorize the cron caller via shared secret -------------------------
  if (!CRON_SECRET) {
    await logEvent('cron_misconfigured', 'CRON_SECRET not set; refusing to run', ip);
    return json({ error: 'Not configured.' }, 503);
  }
  const provided = req.headers.get('x-cron-secret') ?? '';
  if (!provided || !safeEqual(provided, CRON_SECRET)) {
    await logEvent('cron_denied', 'missing/invalid x-cron-secret', ip);
    return json({ error: 'Unauthorized.' }, 401);
  }

  try {
    const { data: metrics, error } = await supabase.rpc('collect_health_metrics');
    if (error || !metrics) {
      await logEvent('api_error', `collect_health_metrics failed: ${error?.message ?? 'no data'}`, ip);
      return json({ error: 'Internal error.' }, 500);
    }

    const findings = evaluate(metrics);
    const severity = findings.reduce<Sev>((s, f) => (RANK[f.severity] > RANK[s] ? f.severity : s), 'ok');
    const summary = severity === 'ok'
      ? 'All clear — no issues detected in the last 24 hours.'
      : `${findings.length} item(s) need attention.`;

    // Always record the run (operator-only history). Service role bypasses RLS.
    const { error: insErr } = await supabase.from('health_reports').insert({ severity, summary, findings });
    if (insErr) await logEvent('api_error', `health_reports insert failed: ${insErr.message}`, ip);

    // Audit trail that the job ran (and at what severity).
    await logEvent('health_check_run', `severity=${severity} findings=${findings.length}`, ip);

    // Contact the operator ONLY when something needs attention, ONLY at ADMIN_EMAIL.
    let emailed = false;
    if (severity !== 'ok') {
      if (!RESEND_API_KEY || !ADMIN_EMAIL) {
        await logEvent('health_email_skipped', `email not sent (severity ${severity}) — ${!ADMIN_EMAIL ? 'ADMIN_ALERT_EMAIL' : 'RESEND_API_KEY'} unset`, ip);
      } else {
        emailed = await sendEmail(ADMIN_EMAIL, `Amlak backend health: ${severity.toUpperCase()}`, renderEmail(severity, findings, metrics));
        if (!emailed) await logEvent('api_error', 'Resend send failed for health alert', ip);
      }
    }

    return json({ severity, findings: findings.length, emailed });
  } catch (e) {
    await logEvent('api_error', String((e as any)?.message ?? e), ip);
    return json({ error: 'Internal error.' }, 500);
  }
});

// Turn raw metrics into plain-English findings. No finding → severity stays 'ok'.
function evaluate(m: any): Finding[] {
  const out: Finding[] = [];
  const add = (area: string, severity: Sev, message: string) => out.push({ area, severity, message });

  // --- Security & break-in attempts (last 24h) ---
  const sec = m.security ?? {};
  const sc = (k: string) => Number(sec[k] ?? 0);
  if (sc('auth_denied') >= 100) add('Security', 'critical', `${sc('auth_denied')} blocked sign-in attempts in 24h — possible password-guessing attack.`);
  else if (sc('auth_denied') >= 20) add('Security', 'warn', `${sc('auth_denied')} blocked sign-in attempts in the last 24h — worth a look.`);
  if (sc('api_error') >= 50) add('Security', 'critical', `${sc('api_error')} server errors in 24h — something may be broken.`);
  else if (sc('api_error') >= 10) add('Security', 'warn', `${sc('api_error')} server errors in the last 24h.`);
  if (sc('rate_limited') >= 50) add('Security', 'warn', `${sc('rate_limited')} requests hit the rate limiter in 24h — heavy or abusive usage.`);
  if (sc('validation_rejected') >= 50) add('Security', 'warn', `${sc('validation_rejected')} malformed requests rejected in 24h — possible probing.`);
  if (sc('cron_denied') >= 1) add('Security', 'warn', `${sc('cron_denied')} unauthorized attempt(s) to trigger a scheduled job — someone is probing your endpoints.`);
  if (sc('cron_misconfigured') >= 1) add('Security', 'warn', `A scheduled job refused to run because its secret is missing — check configuration.`);

  // --- Capacity / when to upgrade ---
  const cap = m.capacity ?? {};
  if (cap.db_bytes != null) {
    const pct = cap.db_bytes / (DB_LIMIT_MB * MB);
    if (pct >= 0.95) add('Capacity', 'critical', `Database is ${(pct * 100).toFixed(0)}% of your ${DB_LIMIT_MB} MB limit — upgrade soon to avoid disruption.`);
    else if (pct >= 0.8) add('Capacity', 'warn', `Database is ${(pct * 100).toFixed(0)}% of your ${DB_LIMIT_MB} MB limit — plan an upgrade.`);
  }
  if (cap.storage_bytes != null) {
    const pct = cap.storage_bytes / (STORAGE_LIMIT_MB * MB);
    if (pct >= 0.95) add('Capacity', 'critical', `Uploaded-file storage is ${(pct * 100).toFixed(0)}% of your ${STORAGE_LIMIT_MB} MB limit.`);
    else if (pct >= 0.8) add('Capacity', 'warn', `Uploaded-file storage is ${(pct * 100).toFixed(0)}% of your ${STORAGE_LIMIT_MB} MB limit.`);
  }

  // --- Unusual growth / load ---
  const g = m.growth ?? {};
  if (Number(g.new_users_24h ?? 0) >= NEW_USERS_WARN) add('Growth', 'warn', `${g.new_users_24h} new sign-ups in 24h — confirm this is expected (real growth or abuse).`);
  if (Number(g.ai_calls_24h ?? 0) >= AI_CALLS_WARN) add('Growth', 'warn', `${g.ai_calls_24h} AI requests in 24h — keep an eye on your Anthropic spend.`);

  // --- App health ---
  const app = m.app ?? {};
  if (Number(app.stuck_reminders ?? 0) >= 1) add('App health', 'warn', `${app.stuck_reminders} reminder(s) are overdue and haven't sent — they may be stuck.`);
  if (app.apply_due_last_status && app.apply_due_last_status !== 'succeeded') {
    add('App health', 'warn', `The nightly rent-update job last finished with status "${app.apply_due_last_status}".`);
  } else if (app.apply_due_last_end) {
    const ageH = (Date.now() - new Date(app.apply_due_last_end).getTime()) / 3_600_000;
    if (ageH > 30) add('App health', 'warn', `The nightly rent-update job hasn't run in ${Math.round(ageH)}h — it may have stopped.`);
  }

  return out;
}

function renderEmail(severity: Sev, findings: Finding[], m: any): string {
  const cap = m.capacity ?? {};
  const g = m.growth ?? {};
  const lines: string[] = [];
  lines.push(`Amlak backend health check — ${severity.toUpperCase()}`);
  lines.push('');
  lines.push('What needs attention:');
  for (const f of findings) lines.push(`  • [${f.area}] ${f.message}`);
  lines.push('');
  lines.push('Snapshot:');
  if (cap.db_bytes != null) lines.push(`  • Database size: ${(cap.db_bytes / MB).toFixed(1)} MB of ${DB_LIMIT_MB} MB`);
  if (cap.storage_bytes != null) lines.push(`  • File storage: ${(cap.storage_bytes / MB).toFixed(1)} MB of ${STORAGE_LIMIT_MB} MB`);
  if (g.total_users != null) lines.push(`  • Total users: ${g.total_users} (+${g.new_users_24h ?? 0} in last 24h)`);
  lines.push(`  • AI requests (24h): ${g.ai_calls_24h ?? 0}`);
  lines.push('');
  lines.push('Full history: Supabase dashboard → Table Editor → health_reports.');
  lines.push('This is an automated operator alert. You are the only recipient.');
  return lines.join('\n');
}

// Returns true only if Resend accepted the message.
async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, text }),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
