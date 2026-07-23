// Scheduled (daily via pg_cron / Supabase scheduled functions) — finds due
// reminders, sends email + creates in-app notifications, marks them sent. Runs
// with the service-role key (no user JWT), so it bypasses RLS intentionally and
// scopes by owner_id per row.
//
// SECURITY: this is NOT a user endpoint. It is deployed with verify_jwt = false
// (see config.toml) and is authorized ONLY by a shared secret: the caller must
// send `x-cron-secret: <CRON_SECRET>`. Without it (or if CRON_SECRET is unset) the
// function refuses to run and records the attempt in security_events. This stops
// anyone holding the public anon key from triggering reminder emails on demand.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const FROM_EMAIL = Deno.env.get('REMINDER_FROM_EMAIL') ?? 'reminders@example.com';
const CRON_SECRET = Deno.env.get('CRON_SECRET');

const intervalText: Record<string, string> = {
  '1_month': 'in 1 month',
  '2_weeks': 'in 2 weeks',
  '1_week': 'in 1 week',
};

// Constant-time string comparison so the secret check doesn't leak length/content
// via response timing.
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
      p_fn: 'send-reminders',
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
    const today = new Date().toISOString().slice(0, 10);

    // Due, still-pending reminders, with their key date + lease context.
    const { data: due, error } = await supabase
      .from('reminders')
      .select('id, owner_id, channel, interval_label, lease_id, key_dates(event_date, description)')
      .lte('remind_on', today)
      .eq('status', 'pending');

    if (error) {
      console.error('[send-reminders] query error:', error);
      await logEvent('api_error', 'reminders query failed', ip);
      return json({ error: 'Internal error.' }, 500);
    }
    if (!due || due.length === 0) return json({ processed: 0 });

    const emailCache = new Map<string, string | null>();
    let processed = 0;

    // Per-owner Settings gates: a reminder email is suppressed when the owner turned its
    // module off (same rule as the dashboard alerts). enabled_features null = everything
    // on (never chosen). Loaded once and used by the insurance/contract sweeps below.
    const prefsByOwner = new Map<string, { enabled: string[] | null; leads: Record<string, number> | null }>();
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('user_id, enabled_features, notify_lead_times');
    for (const pr of (prefs ?? []) as any[]) {
      prefsByOwner.set(pr.user_id, { enabled: pr.enabled_features ?? null, leads: pr.notify_lead_times ?? null });
    }
    const featureOn = (owner: string, key: string) => {
      const en = prefsByOwner.get(owner)?.enabled ?? null;
      return en == null ? true : en.includes(key);
    };
    // The owner's custom "notify me N days ahead" for a type, or null (use built-ins).
    const leadFor = (owner: string, key: string): number | null => {
      const v = prefsByOwner.get(owner)?.leads?.[key];
      return typeof v === 'number' && v > 0 ? v : null;
    };

    for (const r of due as any[]) {
      const kd = r.key_dates;
      const when = intervalText[r.interval_label] ?? 'soon';
      const title = kd?.description ?? 'Upcoming lease date';
      const body = `${title} — ${when} (on ${kd?.event_date}).`;

      // Only flip the row to 'sent' once something actually went out. An email
      // reminder that can't be delivered (no RESEND_API_KEY, unknown address, or a
      // failed Resend call) stays 'pending' and is logged — so it isn't silently
      // dropped and will retry on the next run.
      let delivered = false;
      if (r.channel === 'in_app') {
        const { error: insErr } = await supabase.from('notifications').insert({
          owner_id: r.owner_id,
          reminder_id: r.id,
          lease_id: r.lease_id,
          title,
          body,
        });
        delivered = !insErr;
        if (insErr) await logEvent('reminder_failed', `in_app insert failed for reminder ${r.id}`, ip);
      } else if (r.channel === 'email') {
        if (!RESEND_API_KEY) {
          await logEvent('reminder_skipped', `email reminder ${r.id} not sent — RESEND_API_KEY unset`, ip);
        } else {
          const email = await resolveEmail(r.owner_id, emailCache);
          if (!email) {
            await logEvent('reminder_skipped', `email reminder ${r.id} not sent — no address for owner`, ip);
          } else {
            delivered = await sendEmail(email, title, body);
            if (!delivered) await logEvent('reminder_failed', `Resend send failed for reminder ${r.id}`, ip);
          }
        }
      }

      if (!delivered) continue; // leave 'pending' so the next run retries

      await supabase
        .from('reminders')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', r.id);
      processed++;
    }

    // --- Insurance expiry reminders (email the owner) ----------------------
    // The dashboard already surfaces these in-app (buildAlerts); here we add the
    // email. Recipients are always the landlord/owner, so there's no tenant-domain
    // concern. Dedupe per policy with expiry_notice_bucket so each threshold
    // (1m → 2w → 1w → expired) emails at most once; saveInsurance resets it when
    // the expiry date changes.
    let insuranceProcessed = 0;
    const { data: policies, error: insErr } = await supabase
      .from('insurance_policies')
      .select('id, owner_id, party, insurer, expiry_date, expiry_notice_bucket, properties(name), leases(tenant_name)')
      .not('expiry_date', 'is', null)
      .is('archived_at', null);
    if (insErr) {
      await logEvent('api_error', 'insurance query failed', ip);
    } else {
      const now = new Date();
      for (const p of (policies ?? []) as any[]) {
        const eb = expiryBucket(p.expiry_date, now, leadFor(p.owner_id, 'insurance'));
        if (!eb || eb === p.expiry_notice_bucket) continue; // outside a window, or already sent for it
        if (!featureOn(p.owner_id, 'insurance')) continue;  // Insurance module off in Settings → stay quiet
        if (!RESEND_API_KEY) { await logEvent('reminder_skipped', `insurance ${p.id} not emailed — RESEND_API_KEY unset`, ip); continue; }
        const email = await resolveEmail(p.owner_id, emailCache);
        if (!email) { await logEvent('reminder_skipped', `insurance ${p.id} not emailed — no owner address`, ip); continue; }

        const who = p.party === 'landlord' ? (p.properties?.name || 'a building') : (p.leases?.tenant_name || 'a tenant');
        const kind = p.party === 'landlord' ? 'Building insurance' : 'Tenant insurance';
        const expired = eb === 'expired';
        const subject = `${kind} ${expired ? 'expired' : 'expiring soon'} — ${who}`;
        const text = `${kind} for ${who} ${expired ? 'expired on' : 'expires on'} ${p.expiry_date}.${p.insurer ? ` Insurer: ${p.insurer}.` : ''}`;

        const delivered = await sendEmail(email, subject, text);
        if (!delivered) { await logEvent('reminder_failed', `Resend send failed for insurance ${p.id}`, ip); continue; }
        await supabase.from('insurance_policies').update({ expiry_notice_bucket: eb }).eq('id', p.id);
        insuranceProcessed++;
      }
    }

    // --- Service-contract expiry reminders (email the owner) ----------------
    // Same 1m/2w/1w/ended cadence + once-per-threshold dedupe as insurance, via
    // end_notice_bucket (re-armed by updateServiceContract when the end date changes).
    // Gated by the Service-contracts module toggle.
    let contractProcessed = 0;
    const { data: contracts, error: conErr } = await supabase
      .from('service_contracts')
      .select('id, owner_id, name, vendor, end_date, end_notice_bucket, properties(name)')
      .not('end_date', 'is', null);
    if (conErr) {
      await logEvent('api_error', 'service_contracts query failed', ip);
    } else {
      const now = new Date();
      for (const c of (contracts ?? []) as any[]) {
        const eb = expiryBucket(c.end_date, now, leadFor(c.owner_id, 'contract'));
        if (!eb || eb === c.end_notice_bucket) continue;
        if (!featureOn(c.owner_id, 'contracts')) continue; // Contracts module off → stay quiet
        if (!RESEND_API_KEY) { await logEvent('reminder_skipped', `contract ${c.id} not emailed — RESEND_API_KEY unset`, ip); continue; }
        const email = await resolveEmail(c.owner_id, emailCache);
        if (!email) { await logEvent('reminder_skipped', `contract ${c.id} not emailed — no owner address`, ip); continue; }

        const what = c.name || c.vendor || 'a service contract';
        const where = c.properties?.name ? ` at ${c.properties.name}` : '';
        const ended = eb === 'expired';
        const subject = `Service contract ${ended ? 'ended' : 'ending soon'} — ${what}`;
        const text = `${what}${where} ${ended ? 'ended on' : 'is set to end on'} ${c.end_date}.${c.vendor ? ` Vendor: ${c.vendor}.` : ''} Consider renewing or replacing it so service continues without interruption.`;

        const delivered = await sendEmail(email, subject, text);
        if (!delivered) { await logEvent('reminder_failed', `Resend send failed for contract ${c.id}`, ip); continue; }
        await supabase.from('service_contracts').update({ end_notice_bucket: eb }).eq('id', c.id);
        contractProcessed++;
      }
    }

    // --- Annual-report filing reminders (email the owner) ------------------
    // One email ~1 month before each corporation's annual-report deadline (George's
    // choice: a single 1-month heads-up, not the 2w/1w escalation). Dedupe via
    // due_notice_bucket, which saveAnnualReport resets when the due date rolls forward
    // (Mark filed) so next year re-arms. Past-due sends nothing — the dashboard bell
    // shows it red until it's filed. Not gated by any Settings module (core filing).
    let annualProcessed = 0;
    const { data: reports, error: arErr } = await supabase
      .from('annual_reports')
      .select('id, owner_id, due_date, due_notice_bucket, corporations(name)')
      .not('due_date', 'is', null);
    if (arErr) {
      await logEvent('api_error', 'annual_reports query failed', ip);
    } else {
      const now = new Date();
      for (const r of (reports ?? []) as any[]) {
        const ab = annualBucket(r.due_date, now, leadFor(r.owner_id, 'annual_report'));
        if (!ab || ab === r.due_notice_bucket) continue; // outside the window, or already sent
        if (!RESEND_API_KEY) { await logEvent('reminder_skipped', `annual report ${r.id} not emailed — RESEND_API_KEY unset`, ip); continue; }
        const email = await resolveEmail(r.owner_id, emailCache);
        if (!email) { await logEvent('reminder_skipped', `annual report ${r.id} not emailed — no owner address`, ip); continue; }

        const who = r.corporations?.name || 'a corporation';
        const subject = `Annual report due soon — ${who}`;
        const text = `${who}'s annual report must be filed by ${r.due_date} (about a month away). File it with the state to keep the corporation in good standing.`;

        const delivered = await sendEmail(email, subject, text);
        if (!delivered) { await logEvent('reminder_failed', `Resend send failed for annual report ${r.id}`, ip); continue; }
        await supabase.from('annual_reports').update({ due_notice_bucket: ab }).eq('id', r.id);
        annualProcessed++;
      }
    }

    return json({ processed, insurance: insuranceProcessed, contracts: contractProcessed, annual: annualProcessed });
  } catch (e) {
    console.error('[send-reminders] unhandled error:', e);
    await logEvent('api_error', String((e as any)?.message ?? e), ip);
    return json({ error: 'Internal error.' }, 500);
  }
});

async function resolveEmail(ownerId: string, cache: Map<string, string | null>) {
  if (cache.has(ownerId)) return cache.get(ownerId)!;
  const { data } = await supabase.auth.admin.getUserById(ownerId);
  const email = data?.user?.email ?? null;
  cache.set(ownerId, email);
  return email;
}

// Returns true only if Resend accepted the message, so the caller can keep the
// reminder 'pending' (and retry next run) on any failure instead of losing it.
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

// Bucket a policy/contract by days-to-expiry, matching the dashboard alert thresholds.
// The built-in schedule is 1m → 2w → 1w → expired. When the owner set a custom lead
// LONGER than a month, one earlier 'custom' notice fires first (between the custom lead
// and 1 month out); it never suppresses the later built-in notices because each is a
// distinct bucket value stored for dedupe. Returns null when the date is farther out
// than the effective window.
function expiryBucket(expiry: string, now: Date, customDays: number | null = null): string | null {
  const days = Math.round((new Date(expiry + 'T12:00:00').getTime() - now.getTime()) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 7) return '1w';
  if (days <= 14) return '2w';
  if (days <= 31) return '1m';
  if (customDays && customDays > 31 && days <= customDays) return 'custom';
  return null;
}

// Annual-report deadline → a single '1m' bucket in the month before it's due, plus an
// optional earlier 'custom' notice when the owner set a longer lead. Past due returns
// null (no email — the dashboard bell shows it red until filed).
function annualBucket(due: string, now: Date, customDays: number | null = null): string | null {
  const days = Math.round((new Date(due + 'T12:00:00').getTime() - now.getTime()) / 86400000);
  if (days < 0) return null;
  if (days <= 31) return '1m';
  if (customDays && customDays > 31 && days <= customDays) return 'custom';
  return null;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
