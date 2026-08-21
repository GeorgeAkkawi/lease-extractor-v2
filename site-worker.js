// The public site at amlakre.com — static pages from ./site, plus the two things a
// static asset can't do on its own.
//
// ⚠ WHY THE /sign REDIRECT EXISTS, AND WHY IT MUST NOT BE REMOVED.
// Signing links are built server-side as `${resolveOrigin(req)}/sign/${token}`
// (supabase/functions/send-for-signature/index.ts). Every envelope sent BEFORE the app
// moved to app.amlakre.com is sitting in a tenant's inbox pointing at the apex — which
// is now this worker. Without the redirect below those links 404 and the envelope
// becomes unsignable, with nothing to tell anyone why. There is no expiry on it: an old
// email is old forever.
//
// The app-path redirects that follow are the same idea for the landlord's own bookmarks.
const APP = 'https://app.amlakre.com';

// Paths that belonged to the app when it lived here. Prefix match, so /leases/abc/def
// travels too. Keep this list DISJOINT from the site's own pages — a name added here
// shadows a page of the same name, silently.
// ⚠ `/security` IS NOT IN THIS LIST, and must not be put back. This site has its
// own /security page, linked from the footer of all ten. It survived being listed
// here only because a matching static asset used to win before the Worker ever
// ran — an accident, not a rule, and one that reversed the moment the Worker was
// moved in front of the assets (see run_worker_first in wrangler.site.jsonc).
// amlakre.com/security is the public page; the app's own is at app.amlakre.com.
const APP_PATHS = ['/sign', '/leases', '/financials', '/history', '/settings', '/ask', '/display'];

const FROM = 'Amlak <letters@amlakre.com>';
const MAX = 4000; // per-field ceiling; a lead is a paragraph, not a payload

// Noise control only, mirroring the shape of the throttle in sign-envelope. A Worker
// isolate is per-colo and short-lived, so this stops a naive flood rather than a
// determined one — Cloudflare's own rate limiting is the real gate.
const HITS = new Map();
function flooded(ip, limit = 5, windowMs = 60_000) {
  if (!ip) return false;
  const now = Date.now();
  const recent = (HITS.get(ip) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  HITS.set(ip, recent);
  if (HITS.size > 5000) HITS.clear();
  return recent.length > limit;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const str = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX) : '');
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function handleLead(req, env) {
  const ip = (req.headers.get('cf-connecting-ip') ?? '').trim() || null;
  if (flooded(ip)) return json({ error: 'Too many requests. Please wait a moment.' }, 429);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Bad request.' }, 400);
  }

  // The honeypot answers 200. Telling a bot it was caught only teaches it the field name.
  if (str(body.company_website)) return json({ ok: true });

  const name = str(body.name);
  const email = str(body.email);
  if (!name || !EMAIL_RE.test(email)) return json({ error: 'Name and a valid email are required.' }, 400);

  const key = env.RESEND_API_KEY;
  const to = env.LEAD_TO;
  // ⚠ Both are SECRETS, not vars — this repo is public, and LEAD_TO is a personal inbox.
  //   npx wrangler secret put RESEND_API_KEY -c wrangler.site.jsonc
  //   npx wrangler secret put LEAD_TO        -c wrangler.site.jsonc
  if (!key || !to) return json({ error: 'Mail is not configured.' }, 500);

  const lines = [
    `Name        ${name}`,
    `Email       ${email}`,
    `Properties  ${str(body.properties) || '—'}`,
    `Type        ${str(body.kind) || '—'}`,
    // ⚠ SURFACE THIS FIRST-CLASS. The page promises "email or a short call, your
    // choice"; if the answer is buried where it can be skimmed past, the promise
    // is broken by the one person who has to keep it.
    `Prefers     ${str(body.how) || 'Email is fine'}`,
    '',
    str(body.message) || '(no message)',
    '',
    `— from amlakre.com/consultation${ip ? ` · ${ip}` : ''}`,
  ];

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to,
      // So hitting reply goes to the person who asked, not into the void.
      reply_to: email,
      subject: `Amlak consultation request — ${name}`,
      text: lines.join('\n'),
    }),
  });

  if (!res.ok) return json({ error: 'Could not send.' }, 502);
  return json({ ok: true });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (APP_PATHS.some((p) => path === p || path.startsWith(p + '/'))) {
      return Response.redirect(APP + path + url.search, 302);
    }

    // ⚠ BOTH PATHS, AND THE OLD ONE IS NOT DEAD WEIGHT. The page renamed to
    // /consultation on 2026-08-21, but a browser holding the previous HTML posts
    // to the old endpoint — and a lead that 404s is a lead nobody ever hears
    // about. Costs one line; remove it only once nothing can still be cached.
    if (path === '/api/consultation' || path === '/api/request-access') {
      if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
      return handleLead(req, env);
    }

    // The page moved. 301 rather than 302: this is permanent, and the old URL is
    // in the sitemap Google has already read.
    if (path === '/request-access') {
      return Response.redirect(url.origin + '/consultation', 301);
    }

    return env.ASSETS.fetch(req);
  },
};
