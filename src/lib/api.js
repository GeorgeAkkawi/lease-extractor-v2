// Central data access. Every function is owner-scoped automatically by RLS.
// Pages call these via @tanstack/react-query; shared query keys mean a Page 1
// edit invalidates and refreshes Page 2.
import { supabase, invokeFunction, DEMO_MODE } from './supabaseClient';
import { money, fmtDate } from './format';
import { addMonths } from './renewals';
import { buildRenewalEmail, buildEscalationEmail, buildRenewalApproachingEmail, buildNonRenewalEmail, buildInsuranceRequestEmail, buildContractRenewalEmail } from './emailTemplates';
import { priorRentBefore, computeEscalatedRent } from './escalations';
import { resolveCurrentTerm, cmpRenewal } from './leaseTerm';
import { monthlyScheduleForYear, abatementEnd, leadingFreeMonths } from './abatement';
import { contractCoversYear, contractAnnualCost } from './contracts';
import { byTermEnd } from './leaseSearch';
import { buildPortfolioSnapshot, snapshotToText, snapshotFingerprint, normalizeQuestion } from './portfolio';

// An event is "recent" if its date is no more than this many days in the past.
// Back-dated catch-up only sends a tenant email / notification for recent events;
// purely-historical ones (e.g. an old lease entered today) apply silently.
const RECENT_DAYS = 31;
function isRecentDate(iso, today = new Date()) {
  if (!iso) return true;
  const days = (today.getTime() - new Date(iso + 'T12:00:00').getTime()) / 86400000;
  return days <= RECENT_DAYS;
}

async function rows(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
async function one(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function ownerId() {
  const { data } = await supabase.auth.getUser();
  return data.user?.id;
}

// Client-side upload guardrails (defense in depth — the storage bucket enforces
// the same allowlist + size cap server-side in migration 0020). Reject anything
// that isn't a PDF or common image, and cap the size, before sending any bytes.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MiB — matches the bucket limit
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_UPLOAD_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', DOCX_TYPE,
]);
const ALLOWED_UPLOAD_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'docx']);

function validateUploadFile(file) {
  if (!file) throw new Error('No file selected.');
  if (file.size === 0) throw new Error('That file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).`);
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  // Trust the browser-reported MIME type when present, and always require a
  // known-safe extension (the path/extension is what the extractors key off).
  const typeOk = file.type ? ALLOWED_UPLOAD_TYPES.has(file.type) : true;
  if (!typeOk || !ALLOWED_UPLOAD_EXTS.has(ext)) {
    // Legacy binary .doc can't be parsed reliably — steer the user to a supported form.
    if (ext === 'doc') throw new Error('Old Word ".doc" files aren’t supported. Save it as a PDF or ".docx" and upload that.');
    throw new Error('Unsupported file type. Upload a PDF, a Word document (.docx), or an image (PNG, JPG, WEBP, GIF).');
  }
  return file;
}

// ---- Corporations -----------------------------------------------------------
export const listCorporations = () =>
  rows(supabase.from('corporations').select('*').order('name'));

export const getCorporation = (id) =>
  one(supabase.from('corporations').select('*').eq('id', id).single());

// Distinct corporation contact addresses — the mailboxes the user can send from.
export async function listSenderEmails() {
  const corps = await rows(supabase.from('corporations').select('contact_email').order('name'));
  return [...new Set((corps || []).map((c) => c.contact_email).filter(Boolean))];
}

export const createCorporation = async (name) =>
  one(supabase.from('corporations').insert({ name, owner_id: await ownerId() }).select().single());

// Edit a corporation, including its email "sender identity" (name/address/contacts).
export const updateCorporation = (id, patch) =>
  one(supabase.from('corporations').update(patch).eq('id', id).select().single());

// Build the letterhead/signature "business" object an email template expects
// from a corporation record (the corporation IS the sending entity).
const businessFromCorp = (corp) =>
  corp ? { company_name: corp.name, address: corp.address, contact_email: corp.contact_email, contact_phone: corp.contact_phone } : null;

// Lightweight per-corporation counts for the corp cards (properties + tenants).
export async function getCorpCounts(corpId) {
  const props = await listProperties(corpId);
  let tenants = 0;
  for (const p of props) {
    const ls = await listLeases(p.id);
    tenants += ls.length;
  }
  return { properties: props.length, tenants };
}

// Per-corporation financial roll-up (sum of property totals for a year).
export async function getCorpRollup(corpId, year) {
  const props = await listProperties(corpId);
  let revenue = 0, expenses = 0, noi = 0;
  for (const p of props) {
    const t = await getPropertyTotals(p.id, year);
    if (t) {
      revenue += Number(t.total_revenue) || 0;
      expenses += Number(t.taxes_total) + Number(t.cam_total) + Number(t.roof_total);
      noi += Number(t.noi) || 0;
    }
  }
  return { revenue, expenses, noi };
}

// Batched counts for ALL corporations in two bulk queries (replaces the per-card
// N+1 getCorpCounts). Returns a map { [corpId]: { properties, tenants } }.
export async function listCorpCounts() {
  const [props, leaseRows] = await Promise.all([
    rows(supabase.from('properties').select('id,corporation_id')),
    rows(supabase.from('leases').select('id,property_id')),
  ]);
  const propToCorp = Object.fromEntries((props || []).map((p) => [p.id, p.corporation_id]));
  const counts = {};
  const bump = (corpId) => (counts[corpId] ||= { properties: 0, tenants: 0 });
  for (const p of props || []) bump(p.corporation_id).properties += 1;
  for (const l of leaseRows || []) {
    const corpId = propToCorp[l.property_id];
    if (corpId != null) bump(corpId).tenants += 1;
  }
  return counts;
}

// Batched financial roll-up for ALL corporations for a year (two bulk queries).
// Returns a map { [corpId]: { revenue, expenses, noi } }.
export async function listCorpRollups(year) {
  const props = await rows(supabase.from('properties').select('id,corporation_id'));
  const ids = (props || []).map((p) => p.id);
  const totalsByProp = ids.length ? await listPropertyTotalsByYear(ids, year) : {};
  const rollups = {};
  for (const p of props || []) {
    const r = (rollups[p.corporation_id] ||= { revenue: 0, expenses: 0, noi: 0 });
    const t = totalsByProp[p.id];
    if (t) {
      r.revenue += Number(t.total_revenue) || 0;
      r.expenses += Number(t.taxes_total) + Number(t.cam_total) + Number(t.roof_total);
      r.noi += Number(t.noi) || 0;
    }
  }
  return rollups;
}

// ---- Properties -------------------------------------------------------------
export const listProperties = (corporationId) =>
  rows(supabase.from('properties').select('*').eq('corporation_id', corporationId).order('name'));

export const getProperty = (id) =>
  one(supabase.from('properties').select('*').eq('id', id).single());

export const createProperty = async ({ corporation_id, name, address, building_sf }) =>
  one(
    supabase
      .from('properties')
      .insert({ corporation_id, name, address, building_sf: building_sf ?? null, owner_id: await ownerId() })
      .select()
      .single()
  );

export const updateProperty = (id, patch) =>
  one(supabase.from('properties').update(patch).eq('id', id).select().single());

// ---- Leases (a "tenant" = one lease) ---------------------------------------
// Soonest-expiring lease first (no end date last, ties alphabetical) — the
// order every per-property tenant list shows, incl. the rent-roll export.
export const listLeases = async (propertyId) => {
  const all = await rows(supabase.from('leases').select('*').eq('property_id', propertyId).order('tenant_name'));
  return (all || []).sort(byTermEnd);
};

// Bulk: every lease for a set of properties in ONE query, grouped by property_id.
// Lets a property list load all its cards' leases at once (no per-card waterfall).
// Returns a map { [propertyId]: lease[] } with an entry for every id passed in.
export async function listLeasesByProperties(propertyIds) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  const byProp = Object.fromEntries(ids.map((id) => [id, []]));
  if (ids.length === 0) return byProp;
  const all = await rows(
    supabase.from('leases').select('*').in('property_id', ids).order('tenant_name')
  );
  for (const l of (all || []).sort(byTermEnd)) (byProp[l.property_id] ||= []).push(l);
  return byProp;
}

export const getLease = (id) =>
  one(supabase.from('leases').select('*').eq('id', id).single());

export const createLease = async (lease) => {
  const row = await one(supabase.from('leases').insert({ ...lease, owner_id: await ownerId() }).select().single());
  // Resolve the current period from the dates entered: a back-dated-but-active
  // lease lands on today's rent; a fully-expired one is flagged outdated.
  await backfillLeaseToToday(row.id);
  return getLease(row.id);
};

export const updateLease = (id, patch) =>
  one(supabase.from('leases').update(patch).eq('id', id).select().single());

export const deleteLease = (id) => rows(supabase.from('leases').delete().eq('id', id));

// Remove a tenant while preserving history: archive the lease into the
// expired/renewed log with an outcome (Vacated/Terminated/Renewed), then delete
// the active lease. The landlord keeps a complete record of past tenants.
export async function archiveLease(lease, { status, note, endDate }) {
  const uid = await ownerId();
  await rows(
    supabase.from('expired_leases').insert({
      owner_id: uid,
      property_id: lease.property_id,
      tenant_name: lease.tenant_name,
      sf: lease.square_footage,
      base_rent: lease.base_rent,
      lease_start: lease.lease_start,
      lease_end: endDate || lease.lease_termination_date || null,
      status,
      note: note || null,
      lease_text: lease.lease_text ?? null,
    })
  );
  await deleteLease(lease.id);
}

// ---- Lease document upload + AI extraction ---------------------------------
// Uploads the file to Storage, records a lease_files row, then calls the
// extract-lease Edge Function. Returns { lease_file_id, extraction, lease_text }.
// lease_text is a one-time plain-text copy of the document; we cache it on the
// lease so the per-tenant AI assistant can answer questions cheaply later
// (no re-parsing the PDF).
export async function uploadAndExtract(file) {
  validateUploadFile(file);
  const uid = await ownerId();
  const safe = file.name.replace(/[^\w.-]+/g, '_');
  const path = `${uid}/${Date.now()}-${safe}`;

  const up = await supabase.storage.from('lease-documents').upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (up.error) throw up.error;

  const fileRow = await one(
    supabase
      .from('lease_files')
      .insert({ owner_id: uid, storage_path: path, original_filename: file.name })
      .select()
      .single()
  );

  const { extraction, full_text } = await invokeFunction('extract-lease', { lease_file_id: fileRow.id });
  return { lease_file_id: fileRow.id, extraction, lease_text: full_text || null };
}

// Extract lease fields from pasted text (no file upload). The pasted text is
// itself the exact source, so we keep it as the cached lease_text.
export async function extractFromText(text) {
  const { extraction, full_text } = await invokeFunction('extract-lease', { text });
  return { lease_file_id: null, extraction, lease_text: full_text || text };
}

// Persist an AI-extracted lease plus its escalations/renewals in one go.
// leaseText (the cached plain-text copy) is stored so the AI assistant can read
// it later without re-running extraction.
export async function createLeaseFromExtraction({ propertyId, leaseFileId, lease, escalations, renewals, abatements, aiConfidence, leaseText }) {
  const uid = await ownerId();
  const row = await one(
    supabase
      .from('leases')
      .insert({
        ...lease,
        property_id: propertyId,
        owner_id: uid,
        source: 'ai_extracted',
        extraction_status: 'reviewed',
        ai_confidence: aiConfidence ?? null,
        lease_file_id: leaseFileId,
        lease_text: leaseText ?? null,
      })
      .select()
      .single()
  );
  if (escalations?.length) {
    await rows(
      supabase.from('rent_escalations').insert(
        escalations.map((e) => ({ ...e, lease_id: row.id, owner_id: uid, status: 'scheduled' }))
      )
    );
  }
  if (renewals?.length) {
    await rows(
      supabase
        .from('renewal_options')
        .insert(renewals.map((r) => ({ ...r, lease_id: row.id, owner_id: uid })))
    );
  }
  if (abatements?.length) {
    await rows(
      supabase
        .from('rent_abatements')
        .insert(abatements.map((a) => ({ ...a, lease_id: row.id, owner_id: uid })))
    );
  }
  // Collapse the historical schedule to today: set the current rent + period (or
  // flag the lease outdated), marking past escalations/renewals applied silently.
  await backfillLeaseToToday(row.id);
  return getLease(row.id);
}

// Set (or correct) a lease's start date and, from it, DATE the whole rent schedule.
// Many commercial leases print no commencement date — it's a formula ("120 days after
// delivery of possession", "when the tenant opens"), so the AI reads the rent table by
// LEASE YEAR ("Year 1 … Year 5") with no real dates and the lease is saved start-less,
// its undated steps deliberately NOT inserted (buildEscalations can't place them). The
// full read is still cached on the linked lease_files row (extraction_raw). Once the
// landlord supplies the real start date, this re-derives everything from that cache:
//   • sets lease_start (and, if blank, lease_termination_date = start + term − 1 day),
//   • dates the escalations (months_from_start → real dates) and abatements,
//   • rolls the lease forward to today so the current rent is right.
// GUARDED: it only inserts schedule rows the lease is MISSING — it never duplicates or
// overwrites steps the landlord entered by hand. Safe to call for any lease; when there's
// no cached schedule or the rows already exist, it just updates the date(s).
export async function anchorLeaseSchedule(leaseId, startDate) {
  const start = isoDateOrNull(startDate);
  if (!start) throw new Error('Enter a real date (YYYY-MM-DD).');
  const lease = await getLease(leaseId);
  if (!lease) throw new Error('Lease not found.');
  const uid = await ownerId();

  // The cached full extraction (raw AI read) lives on the linked lease_files row.
  let ex = null;
  if (lease.lease_file_id) {
    const fileRows = await rows(
      supabase.from('lease_files').select('extraction_raw').eq('id', lease.lease_file_id).limit(1)
    );
    ex = fileRows?.[0]?.extraction_raw || null;
  }

  // 1) The start date, and a term-based end date when none is on file.
  const patch = { lease_start: start };
  const termMonths = Number(ex?.term_months?.value) || 0;
  if (!lease.lease_termination_date && termMonths > 0) {
    const after = addMonths(start, termMonths); // first day AFTER the term
    if (after) {
      const d = new Date(after + 'T12:00:00');
      d.setDate(d.getDate() - 1);              // term runs through the day before
      patch.lease_termination_date = d.toISOString().slice(0, 10);
    }
  }
  await updateLease(leaseId, patch);

  // 2) Date + insert any schedule rows the lease is MISSING (never touch existing ones).
  if (ex) {
    const [existingEsc, existingAb] = await Promise.all([listEscalations(leaseId), listAbatements(leaseId)]);
    if (existingEsc.length === 0) {
      const base = Number(ex?.base_rent?.value) || Number(lease.base_rent) || 0;
      // If the lease opens with a FREE-rent period, paid rent commences after it — so a
      // lease-year rent table is dated from that rent-commencement point, not the start.
      const freeMo = leadingFreeMonths(start, ex.abatements);
      const rentStart = freeMo > 0 ? (addMonths(start, freeMo) || start) : start;
      const escs = buildEscalations(base, ex.escalations, rentStart); // anchors months_from_start → real dates
      if (escs.length) {
        await rows(
          supabase.from('rent_escalations').insert(escs.map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled' })))
        );
      }
    }
    if (existingAb.length === 0 && Array.isArray(ex.abatements) && ex.abatements.length) {
      // A free-rent window usually begins at rent commencement — fall its start back to
      // the lease start when the lease didn't print a separate date for it.
      const abs = buildAbatements(ex.abatements.map((a) => ({ ...a, start_date: a.start_date || start })));
      if (abs.length) {
        await rows(
          supabase.from('rent_abatements').insert(abs.map((a) => ({ ...a, lease_id: leaseId, owner_id: uid })))
        );
      }
    }
  }

  // 3) Roll forward to today so the current rent / period reflect the now-dated schedule.
  await backfillLeaseToToday(leaseId);
  return getLease(leaseId);
}

// Accept ONLY a real calendar date in YYYY-MM-DD form. Anything else — prose the model
// sometimes returns for a relative deadline (e.g. "180 days prior to expiration of the
// Original Term"), a blank, or a malformed value — becomes null, so it can never reach a
// Postgres `date` column (which would reject it and fail the entire lease save).
export function isoDateOrNull(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00`);
  return isNaN(d.getTime()) ? null : s;
}

// Shape AI-extracted escalation rows into rent_escalations inserts, computing the
// new_base_rent for each step from the prior rent (shared by lease intake +
// addendum import). Rows without a real ISO effective_date are dropped (they can't be
// scheduled) — UNLESS the row carries a months_from_start offset and an anchorDate is
// given, in which case the real date is anchorDate + that many months. That's how a
// lease-year rent table with no printed dates (e.g. Wingstop "Year 1 … Year 6") gets its
// steps dated off the lease start the user confirms. Sorted by date so % / $ steps
// compound correctly. anchorDate is optional; the addendum path passes none, so its dated
// rows behave exactly as before.
export function buildEscalations(baseRent, escalations, anchorDate) {
  if (!escalations?.length) return [];
  const anchor = isoDateOrNull(anchorDate);
  const sorted = escalations
    .map((e) => {
      let date = isoDateOrNull(e.effective_date);
      if (!date && anchor && e.months_from_start != null && isFinite(Number(e.months_from_start))) {
        date = addMonths(anchor, Number(e.months_from_start));
      }
      return { ...e, effective_date: date };
    })
    .filter((e) => e.effective_date)
    .sort((a, b) => (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : 0));
  let prior = Number(baseRent) || 0;
  return sorted.map((e) => {
    const type = e.escalation_type || 'manual';
    const computed = e.new_base_rent != null
      ? Number(e.new_base_rent)
      : computeEscalatedRent(prior, { escalation_type: type, escalation_value: Number(e.escalation_value) });
    prior = computed;
    return { effective_date: e.effective_date, escalation_type: type, escalation_value: e.escalation_value ?? null, new_base_rent: computed };
  });
}

// Shape AI-extracted renewal options into renewal_options inserts. notice_by_date is
// sanitized to a real date or null; a relative/prose deadline is preserved in notes
// rather than dropped or allowed to crash the save.
export function buildRenewals(renewals) {
  if (!renewals?.length) return [];
  return renewals.map((r) => {
    const notice = isoDateOrNull(r.notice_by_date);
    const rawNotice = r.notice_by_date != null ? String(r.notice_by_date).trim() : '';
    const noticeNote = rawNotice && !notice ? `Notice: ${rawNotice}` : null;
    const notes = [r.notes, noticeNote].filter(Boolean).join(' · ') || null;
    return {
      option_label: r.option_label ?? null,
      notice_by_date: notice,
      term_months: r.term_months ?? null,
      new_rent: r.new_rent ?? null,
      annual_escalation_pct: r.annual_escalation_pct ?? null,
      notes,
    };
  });
}

// ---- Rent abatements (free / reduced base-rent windows) ---------------------
// A lease or addendum can grant free or reduced BASE rent for a period. The window
// math lives in src/lib/abatement.js, mirrored by abatement_credit() in SQL; CAM /
// taxes still accrue. These feed the monthly tracker, the phase header, and the
// invoice credit line — nothing here touches the lease's own base_rent.
export const listAbatements = (leaseId) =>
  rows(supabase.from('rent_abatements').select('*').eq('lease_id', leaseId).order('start_date'));

// Bulk: every abatement for a set of leases in ONE query, grouped by lease_id.
export async function listAbatementsForLeases(leaseIds) {
  const ids = [...new Set((leaseIds || []).filter(Boolean))];
  const byLease = Object.fromEntries(ids.map((id) => [id, []]));
  if (ids.length === 0) return byLease;
  const all = await rows(supabase.from('rent_abatements').select('*').in('lease_id', ids).order('start_date'));
  for (const a of all || []) (byLease[a.lease_id] ||= []).push(a);
  return byLease;
}

export const createAbatement = async (a) =>
  one(supabase.from('rent_abatements').insert({ ...a, owner_id: await ownerId() }).select().single());

export const deleteAbatement = (id) => rows(supabase.from('rent_abatements').delete().eq('id', id));

// Shape AI-extracted / review-form abatement rows into rent_abatements inserts. Each
// input: { start_date, months?, end_date?, kind, value?, note? }. The window end comes
// from an explicit end_date or start + N months (inclusive). Rows without a resolvable
// start+end are dropped. Shared by lease intake + addendum apply so both agree.
export function buildAbatements(abatements) {
  if (!abatements?.length) return [];
  return abatements
    .map((a) => {
      const start = isoDateOrNull(a.start_date);
      const end = isoDateOrNull(a.end_date) || (start && a.months ? abatementEnd(start, a.months) : null);
      if (!start || !end) return null;
      const kind = ['free', 'percent', 'amount'].includes(a.kind) ? a.kind : 'free';
      return { start_date: start, end_date: end, kind, value: kind === 'free' ? null : (a.value ?? null), note: a.note ?? null };
    })
    .filter(Boolean);
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ---- Email two-factor auth -------------------------------------------------
// Read the current user's 2FA preference. Defaults to "off" on any error (or in
// demo mode) so the app never gets stuck behind a challenge it can't satisfy.
export async function getSecuritySettings() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { email_2fa_enabled: false, last_2fa_at: null };
    const { data } = await supabase
      .from('user_security')
      .select('email_2fa_enabled,last_2fa_at')
      .eq('user_id', user.id)
      .maybeSingle();
    return { email_2fa_enabled: !!data?.email_2fa_enabled, last_2fa_at: data?.last_2fa_at ?? null };
  } catch {
    return { email_2fa_enabled: false, last_2fa_at: null };
  }
}

// Email a fresh 6-digit code to the signed-in user; verify a code they entered.
// intent: 'login' (default), 'enable', or 'disable'.
export const sendTwoFactorCode = () => invokeFunction('send-2fa-code', {});
export const verifyTwoFactorCode = (code, intent = 'login') =>
  invokeFunction('verify-2fa-code', { code, intent });

// ---- Global search ("Ask Amlak") -------------------------------------------
// One bulk load of the searchable entities; the search bar filters this locally
// (no AI, no per-keystroke network) so results appear instantly as you type.
export async function fetchSearchIndex() {
  const [corps, props, leases, renewals, expired] = await Promise.all([
    rows(supabase.from('corporations').select('id,name,address')),
    rows(supabase.from('properties').select('id,name,address,corporation_id,building_sf')),
    rows(supabase.from('leases').select('id,tenant_name,tenant_email,tenant_contact_name,property_id,square_footage,base_rent,lease_start,lease_termination_date,no_renewal_option,roof_responsible,lease_terms,is_active')),
    rows(supabase.from('renewal_options').select('lease_id,status')),
    rows(supabase.from('expired_leases').select('id,tenant_name,property_id,status,lease_end,base_rent,sf')),
  ]);
  const propById = Object.fromEntries((props || []).map((p) => [p.id, p]));
  const liveRenewal = new Set((renewals || []).filter((r) => r.status !== 'applied').map((r) => r.lease_id));
  return {
    corporations: corps || [],
    properties: props || [],
    leases: (leases || []).map((l) => {
      const p = propById[l.property_id];
      return { ...l, property_name: p?.name || '', corporation_id: p?.corporation_id || null, has_renewal: liveRenewal.has(l.id) };
    }),
    expired: (expired || []).map((e) => {
      const p = propById[e.property_id];
      return { ...e, property_name: p?.name || '', corporation_id: p?.corporation_id || null };
    }),
  };
}

// ---- Lease AI assistant -----------------------------------------------------
// Ask a free-text question about a single lease. The Edge Function answers with a
// small, cheap model + prompt caching. Pass leaseText to query an archived lease
// directly (its text travels with the expired record); for a live lease, leaseId
// lets the function read the cached lease_text server-side. Returns the answer.
export async function askLease(leaseId, question, leaseText) {
  const payload = { question };
  if (leaseText && leaseText.trim()) payload.lease_text = leaseText;
  if (leaseId) payload.lease_id = leaseId;
  const { answer } = await invokeFunction('ask-lease', payload);
  return answer;
}

// ---- Ask Amlak: portfolio assistant ----------------------------------------
// Answer a free-text question about the account's OWN records (tenants, insurance,
// service contracts, rent, dates, balances). Cheap by design: only a compact,
// facts-only summary is sent to the model — never any documents — so a question is
// sub-cent; every answer is cached per user keyed by a portfolio fingerprint, so a
// repeat on an unchanged portfolio is $0 and never calls the model.

// Assemble the compact snapshot from a few bulk reads (all under the caller's RLS).
export async function fetchPortfolioSnapshot() {
  const [corporations, properties, leases, insurance, contracts, renewals, balances] = await Promise.all([
    rows(supabase.from('corporations').select('id,name,address')),
    rows(supabase.from('properties').select('id,name,address,corporation_id,building_sf')),
    rows(supabase.from('leases').select('id,tenant_name,property_id,square_footage,base_rent,lease_start,lease_termination_date,is_active,updated_at,created_at')),
    rows(supabase.from('insurance_policies').select('id,party,property_id,lease_id,insurer,expiry_date,archived_at,updated_at,created_at').is('archived_at', null)),
    rows(supabase.from('service_contracts').select('id,property_id,service_type,vendor,amount,frequency,end_date,updated_at,created_at')),
    rows(supabase.from('renewal_options').select('lease_id,status')),
    rows(supabase.from('v_invoice_balances').select('lease_id,balance,display_status,due_date')),
  ]);
  return buildPortfolioSnapshot({ corporations, properties, leases, insurance, contracts, renewals, balances });
}

// Cache read/write (best-effort — the feature still works if the table is absent).
async function getCachedPortfolioAnswer(questionNorm, fingerprint) {
  try {
    const { data } = await supabase
      .from('portfolio_qa_cache')
      .select('answer_json')
      .eq('question_norm', questionNorm)
      .eq('snapshot_fingerprint', fingerprint)
      .maybeSingle();
    return data?.answer_json?.answer ?? null;
  } catch {
    return null;
  }
}

async function writeCachedPortfolioAnswer(questionNorm, fingerprint, answer) {
  const uid = await ownerId();
  // One row per (user, question): drop any stale-fingerprint rows for this question
  // before inserting the fresh answer.
  await supabase.from('portfolio_qa_cache').delete().eq('user_id', uid).eq('question_norm', questionNorm);
  await supabase.from('portfolio_qa_cache').insert({
    user_id: uid,
    question_norm: questionNorm,
    snapshot_fingerprint: fingerprint,
    answer_json: { answer },
  });
}

// Returns { answer, fromCache }. Pass the snapshot from fetchPortfolioSnapshot.
export async function askPortfolioQuestion(question, snapshot) {
  const questionNorm = normalizeQuestion(question);
  if (!questionNorm) return { answer: '', fromCache: false };
  const snapshotText = snapshotToText(snapshot);

  // Demo mode: canned, data-driven answer — no network, no caching. The structured
  // snapshot rides along so the mock can answer from real seeded data.
  if (DEMO_MODE) {
    const { answer } = await invokeFunction('ask-portfolio', { question, snapshot: snapshotText, snapshot_obj: snapshot });
    return { answer, fromCache: false };
  }

  const fingerprint = snapshot?.fingerprint || snapshotFingerprint({});
  const cached = await getCachedPortfolioAnswer(questionNorm, fingerprint);
  if (cached) return { answer: cached, fromCache: true };

  const { answer } = await invokeFunction('ask-portfolio', { question, snapshot: snapshotText });
  try {
    await writeCachedPortfolioAnswer(questionNorm, fingerprint, answer);
  } catch {
    /* caching is best-effort — never fail the answer on a cache write */
  }
  return { answer, fromCache: false };
}

// ---- Generic document vault (insurance, contracts) -------------------------
// Ask a question about any cached document text (one cheap Haiku call + prompt
// caching). kind tailors the assistant's framing: 'insurance' | 'contract' | …
export async function askDoc(text, question, kind) {
  const { answer } = await invokeFunction('ask-doc', { text, question, kind });
  return answer;
}

// Upload a document to storage (shared bucket); returns its storage path.
export async function uploadDoc(file) {
  validateUploadFile(file);
  const uid = await ownerId();
  const safe = file.name.replace(/[^\w.-]+/g, '_');
  const path = `${uid}/${Date.now()}-${safe}`;
  const up = await supabase.storage.from('lease-documents').upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (up.error) throw up.error;
  return path;
}

// One-time AI extraction of an insurance policy: key-facts + a cached transcription.
export async function extractInsurance({ text, storagePath }) {
  const { fields, full_text } = await invokeFunction('extract-insurance', { text, storage_path: storagePath });
  return { fields: fields || {}, policy_text: full_text || text || null };
}

// One-time AI extraction of a service contract: key-terms + a cached transcription.
// `name` is the landlord's label for the contract (helps the demo route a type).
export async function extractContract({ text, storagePath, name }) {
  const { fields, full_text } = await invokeFunction('extract-contract', { text, storage_path: storagePath, name });
  return { fields: fields || {}, contract_text: full_text || text || null };
}

// ---- Insurance policies (landlord per-property, tenant per-lease) -----------
// Only the ACTIVE policy (archived_at is null) is the current one shown on the
// card and used for expiry alerts. Removed policies are either archived (kept for
// the "expired items in history" list) or hard-deleted.
export const getPropertyInsurance = (propertyId) =>
  one(supabase.from('insurance_policies').select('*').eq('property_id', propertyId).eq('party', 'landlord').is('archived_at', null).maybeSingle());

export const getTenantInsurance = (leaseId) =>
  one(supabase.from('insurance_policies').select('*').eq('lease_id', leaseId).eq('party', 'tenant').is('archived_at', null).maybeSingle());

// Insert-or-update the active policy row for this scope. Changing the expiry date
// clears expiry_notice_bucket so the reminder emails re-arm for the new date.
export async function saveInsurance({ party, propertyId, leaseId, ...fields }) {
  const uid = await ownerId();
  const existing = party === 'landlord' ? await getPropertyInsurance(propertyId) : await getTenantInsurance(leaseId);
  const payload = { party, property_id: propertyId ?? null, lease_id: leaseId ?? null, ...fields };
  if (existing && 'expiry_date' in fields && fields.expiry_date !== existing.expiry_date) {
    payload.expiry_notice_bucket = null;
  }
  if (existing) return one(supabase.from('insurance_policies').update(payload).eq('id', existing.id).select().single());
  return one(supabase.from('insurance_policies').insert({ ...payload, owner_id: uid }).select().single());
}

// History: archived (removed-but-kept) policies for one scope, newest first.
export const listArchivedInsurance = ({ party, propertyId, leaseId }) => {
  let q = supabase.from('insurance_policies').select('*').eq('party', party).not('archived_at', 'is', null);
  q = party === 'landlord' ? q.eq('property_id', propertyId) : q.eq('lease_id', leaseId);
  return rows(q.order('archived_at', { ascending: false }));
};

// Remove policy → "Save to history": keep the row + its documents, just archive it.
export const archiveInsurance = (id) =>
  one(supabase.from('insurance_policies').update({ archived_at: new Date().toISOString() }).eq('id', id).select().single());

// Remove policy → "Delete permanently": drop the row (its documents cascade).
export const deleteInsurance = (id) =>
  rows(supabase.from('insurance_policies').delete().eq('id', id));

// ---- Extra documents attached to a policy (renewals, premium notices, any PDF)
export const listInsuranceDocuments = (policyId) =>
  rows(supabase.from('insurance_documents').select('*').eq('policy_id', policyId).order('created_at'));

export async function addInsuranceDocument({ policyId, label, file, note }) {
  const storage_path = file ? await uploadDoc(file) : null;
  return one(supabase.from('insurance_documents')
    .insert({ owner_id: await ownerId(), policy_id: policyId, label, storage_path, note: note || null })
    .select().single());
}

export const removeInsuranceDocument = (id) =>
  rows(supabase.from('insurance_documents').delete().eq('id', id));

// Short-lived signed URL to open a stored document (the lease-documents bucket is private).
export async function signDocUrl(storagePath) {
  if (!storagePath) return null;
  const { data, error } = await supabase.storage.from('lease-documents').createSignedUrl(storagePath, 120);
  if (error) throw error;
  return data?.signedUrl ?? null;
}

// ---- Service contracts (per property; standing maintenance agreements) ------
export const listServiceContracts = (propertyId) =>
  rows(supabase.from('service_contracts').select('*').eq('property_id', propertyId).order('created_at'));

export const addServiceContract = async (c) =>
  one(supabase.from('service_contracts').insert({ ...c, owner_id: await ownerId() }).select().single());

export const updateServiceContract = (id, patch) =>
  one(supabase.from('service_contracts').update(patch).eq('id', id).select().single());

export const deleteServiceContract = (id) =>
  rows(supabase.from('service_contracts').delete().eq('id', id));

// ---- Escalations & renewals -------------------------------------------------
export const listEscalations = (leaseId) =>
  rows(
    supabase.from('rent_escalations').select('*').eq('lease_id', leaseId).order('effective_date')
  );

// Bulk: every escalation for a set of leases in ONE query, grouped by lease_id.
// Lets a lease list load all rows' "next escalation" at once (no per-row waterfall).
// Returns a map { [leaseId]: escalation[] } with an entry for every id passed in.
export async function listEscalationsByLeases(leaseIds) {
  const ids = [...new Set((leaseIds || []).filter(Boolean))];
  const byLease = Object.fromEntries(ids.map((id) => [id, []]));
  if (ids.length === 0) return byLease;
  const all = await rows(
    supabase.from('rent_escalations').select('*').in('lease_id', ids).order('effective_date')
  );
  for (const e of all || []) (byLease[e.lease_id] ||= []).push(e);
  return byLease;
}

export const createEscalation = async (esc) =>
  one(
    supabase.from('rent_escalations').insert({ ...esc, owner_id: await ownerId() }).select().single()
  );

export const updateEscalation = (id, patch) =>
  one(supabase.from('rent_escalations').update(patch).eq('id', id).select().single());

export const deleteEscalation = (id) =>
  rows(supabase.from('rent_escalations').delete().eq('id', id));

// Apply ONE escalation (called automatically on/after its effective date). It
// makes the increase real — updates the lease's actual base rent — marks the
// escalation applied, and drops a notification with a tenant rent-adjustment
// email. There is no early/manual apply; this only runs once the date arrives.
export async function applyEscalation(escalation) {
  const uid = await ownerId();
  const lease = await getLease(escalation.lease_id);
  const prop = lease ? await getProperty(lease.property_id) : null;
  const corp = prop?.corporation_id ? await getCorporation(prop.corporation_id) : null;
  const business = businessFromCorp(corp);
  const escs = await listEscalations(escalation.lease_id);
  const priorRent = priorRentBefore(lease, escs, escalation.effective_date);
  const newRent = escalation.new_base_rent != null ? Number(escalation.new_base_rent) : priorRent;

  const updated = await updateEscalation(escalation.id, { status: 'applied', applied_at: new Date().toISOString() });
  await updateLease(escalation.lease_id, { base_rent: newRent }); // change the actual base rent in the lease terms

  // Only notify (and draft a tenant email) for a recently-crossed increase. An
  // escalation whose date is long past — e.g. a historical lease entered today —
  // applies silently so the inbox isn't flooded with ancient adjustments.
  if (isRecentDate(escalation.effective_date)) {
    const email = buildEscalationEmail({
      business,
      tenant_name: lease?.tenant_name,
      contact_name: lease?.tenant_contact_name,
      tenant_email: lease?.tenant_email,
      propertyName: prop?.name,
      effectiveDate: escalation.effective_date,
      priorRent,
      newRent,
      escalationType: escalation.escalation_type,
      escalationValue: escalation.escalation_value,
    });

    await one(
      supabase
        .from('notifications')
        .insert({
          owner_id: uid,
          lease_id: escalation.lease_id,
          property_id: lease?.property_id,
          corporation_id: prop?.corporation_id,
          kind: 'escalation_applied',
          title: `Rent escalation applied — ${lease?.tenant_name || 'tenant'}`,
          body: `Effective ${fmtDate(escalation.effective_date)} · base rent now ${money(newRent)}`,
          email_to: lease?.tenant_email || null,
          email_to_2: lease?.tenant_email_2 || null,
          email_from: business?.contact_email || null,
          email_subject: email.subject,
          email_body: email.body,
          read: false,
        })
        .select()
        .single()
    );
  }
  return updated;
}

// Auto-apply every scheduled escalation whose effective date has arrived. Runs on
// app load (and as a scheduled job at go-live) — the same "only on the date" rule
// as renewals.
export async function applyDueEscalations(today = new Date()) {
  const todayIso = today.toISOString().slice(0, 10);
  const due = await rows(
    supabase.from('rent_escalations').select('*').eq('status', 'scheduled').lte('effective_date', todayIso).order('effective_date')
  );
  const applied = [];
  const leaseCache = new Map();
  for (const e of due) {
    if (!leaseCache.has(e.lease_id)) leaseCache.set(e.lease_id, await getLease(e.lease_id));
    const lease = leaseCache.get(e.lease_id);
    // A step dated on/after the committed term end belongs to an un-exercised renewal
    // option — leave it scheduled until the renewal is confirmed (which extends the
    // term and pulls the step back inside it). Otherwise a lapsed lease would silently
    // jump to an option's rent nobody exercised.
    if (lease?.lease_termination_date && String(e.effective_date) >= String(lease.lease_termination_date)) continue;
    await applyEscalation(e);
    applied.push(e.id);
  }
  return applied;
}

// Scheduled escalations across all leases in a property (for the property-level
// recommendation roll-up). Returns rows joined with the tenant name.
export const listScheduledEscalationsForProperty = async (propertyId) => {
  const leaseRows = await listLeases(propertyId);
  if (leaseRows.length === 0) return [];
  const byId = Object.fromEntries(leaseRows.map((l) => [l.id, l]));
  const escs = await rows(
    supabase
      .from('rent_escalations')
      .select('*')
      .in('lease_id', Object.keys(byId))
      .eq('status', 'scheduled')
      .order('effective_date')
  );
  return escs.map((e) => ({ ...e, lease: byId[e.lease_id] }));
};

export const listRenewals = (leaseId) =>
  rows(supabase.from('renewal_options').select('*').eq('lease_id', leaseId).order('notice_by_date'));

export const createRenewal = async (r) =>
  one(supabase.from('renewal_options').insert({ ...r, owner_id: await ownerId(), status: r.status || 'pending' }).select().single());

export const updateRenewal = (id, patch) =>
  one(supabase.from('renewal_options').update(patch).eq('id', id).select().single());

export const deleteRenewal = (id) =>
  rows(supabase.from('renewal_options').delete().eq('id', id));

// ---- Current-period back-fill ----------------------------------------------
// Mark escalations/renewals applied WITHOUT a notification or tenant email — used
// when collapsing a back-dated lease's historical schedule to today.
async function markAppliedSilently(escIds = [], renIds = []) {
  const at = new Date().toISOString();
  for (const id of escIds) await updateEscalation(id, { status: 'applied', applied_at: at });
  for (const id of renIds) await updateRenewal(id, { status: 'applied', applied_at: at });
}

// Resolve where a lease is TODAY (by pure date math) and write that state:
//  • active  → set the current base rent + period window, flag is_active, and mark
//              every past escalation/renewal applied silently (no email flood). If
//              we've moved past the original term, archive it once to History.
//  • expired → flag is_active=false (outdated) and add NO financial data; the UI
//              prompts for an extension/addendum, which re-runs this and activates it.
// Idempotent: re-running on an already-current lease is a quiet no-op.
export async function backfillLeaseToToday(leaseId, today = new Date()) {
  const lease = await getLease(leaseId);
  if (!lease) return null;
  const [escs, rens] = await Promise.all([listEscalations(leaseId), listRenewals(leaseId)]);
  const res = resolveCurrentTerm({ lease, escalations: escs, renewals: rens, today });

  if (res.status === 'expired') {
    // Outdated (term ended, nothing carrying it forward) — but still write the
    // last-known rent so the base rent shown up top agrees with the escalation
    // table. Without this, a past-dated rent step marked "applied" here would leave
    // the header rent stale forever (applyDueEscalations skips applied rows).
    const patch = { is_active: false };
    if (res.currentRent != null && Number(res.currentRent) !== Number(lease.base_rent)) patch.base_rent = res.currentRent;
    if (lease.is_active !== false || patch.base_rent != null) await updateLease(leaseId, patch);
    await markAppliedSilently(res.consumedEscalationIds, res.consumedRenewalIds);
    return res;
  }

  // Archive the original term once when today has rolled into a renewal option.
  if (res.currentRenewalId && lease.lease_start && lease.lease_termination_date) {
    await rows(
      supabase.from('expired_leases').insert({
        owner_id: await ownerId(),
        property_id: lease.property_id,
        tenant_name: lease.tenant_name,
        sf: lease.square_footage,
        base_rent: lease.base_rent,
        lease_start: lease.lease_start,
        lease_end: lease.lease_termination_date,
        status: 'Renewed',
        note: `Historical term — back-filled on entry; current term computed as of ${fmtDate(today.toISOString().slice(0, 10))}`,
        lease_text: lease.lease_text ?? null,
      })
    );
  }

  const patch = { is_active: true, base_rent: res.currentRent };
  if (res.periodStart) patch.lease_start = res.periodStart;
  if (res.periodEnd) patch.lease_termination_date = res.periodEnd;
  await updateLease(leaseId, patch);
  await markAppliedSilently(res.consumedEscalationIds, res.consumedRenewalIds);
  // Sync renewal options with the now-current schedule (evidence-gated + idempotent —
  // bails immediately for leases it doesn't apply to). Re-fetch so it sees the dates
  // this back-fill just wrote.
  await reconcileRenewalOptions(await getLease(leaseId), today);
  return res;
}

// ---- History events (per-building timeline of what happened to a lease) ------
// Each event is attributed to a tenant (stored at write time). For any older row that
// predates that column, fall back to the lease's current tenant so the timeline can
// always show WHICH tenant an event was about.
export async function listHistoryEvents(propertyId) {
  const events = await rows(
    supabase.from('history_events').select('*').eq('property_id', propertyId).order('created_at', { ascending: false })
  );
  if (!events.some((e) => !e.tenant_name && e.lease_id)) return events;
  const leaseRows = await listLeases(propertyId);
  const byId = Object.fromEntries(leaseRows.map((l) => [l.id, l.tenant_name]));
  return events.map((e) => (e.tenant_name ? e : { ...e, tenant_name: byId[e.lease_id] || null }));
}

// Record a lifecycle event (tenant assigned, term extended, renewal confirmed, …).
// `tenant_name` pins the event to the tenant it happened to. Non-fatal: a logging
// failure must never break the action that triggered it.
export async function logHistoryEvent({ property_id, lease_id, type, description, tenant_name = null, event_date = null, meta = null }) {
  try {
    return await one(
      supabase.from('history_events').insert({ owner_id: await ownerId(), property_id, lease_id, type, description, tenant_name, event_date, meta }).select().single()
    );
  } catch {
    return null;
  }
}

// ---- Addendums / riders (tracked amendments that update a lease) -------------
export const listAddendums = (leaseId) =>
  rows(supabase.from('lease_addendums').select('*').eq('lease_id', leaseId).order('amendment_date'));

export const createAddendum = async (a) =>
  one(supabase.from('lease_addendums').insert({ ...a, owner_id: await ownerId() }).select().single());

export const deleteAddendum = (id) =>
  rows(supabase.from('lease_addendums').delete().eq('id', id));

// One-time AI extraction of a rider/amendment (paid Claude call). Mirrors
// extractContract: accepts pasted text or an uploaded file (PDF/scan/photo/Word).
export async function extractAddendum({ text, storagePath, squareFootage }) {
  const { fields, full_text } = await invokeFunction('extract-addendum', { text, storage_path: storagePath, square_footage: squareFootage ?? null });
  return { fields: fields || {}, addendum_text: full_text || text || null };
}

// Apply an addendum's changes to the lease, then re-resolve the current period.
// `changes` carries normalized values: { extensionEnd, newRent, escalations[], renewals[] }.
// Escalation/renewal rows are stamped with addendum_id for provenance.
//   • A committed EXTENSION moves the lease's own termination date DIRECTLY and lays
//     its new base rent in as a dated step. It is certain — never a renewal option.
//     (Modeling an extension as a chained renewal was the old bug that let it double-
//     count and let un-exercised options masquerade as committed term.)
//   • A renewal OPTION is recorded status='pending' and NEVER touches the term. It
//     only extends the lease later, via confirmRenewal, once the landlord confirms it.
// Returns the resolver result. `today` is injectable for deterministic replays/tests.
export async function applyAddendum(addendum, changes = {}, today = new Date()) {
  const uid = await ownerId();
  const leaseId = addendum.lease_id;
  const lease = await getLease(leaseId);

  // A committed extension's new base rent takes effect where the new term begins —
  // i.e. at the prior term end — so model it as the first dated step, ahead of any
  // later step-ups the rider spells out.
  const fromEnd = lease?.lease_termination_date || addendum.amendment_date || null;
  const escInputs = [...(changes.escalations || [])];
  if (changes.extensionEnd && changes.newRent != null && fromEnd) {
    escInputs.unshift({ effective_date: fromEnd, escalation_type: 'manual', escalation_value: null, new_base_rent: Number(changes.newRent) });
  }

  // Escalations contributed by the rider (incl. the extension's opening rent above).
  const escRows = buildEscalations(lease?.base_rent, escInputs);
  if (escRows.length) {
    await rows(
      supabase.from('rent_escalations').insert(
        escRows.map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled', addendum_id: addendum.id }))
      )
    );
  }

  // Extend the committed term directly — the lease's own end date is the single
  // source of truth for how long the tenant is committed.
  if (changes.extensionEnd) {
    await updateLease(leaseId, { lease_termination_date: changes.extensionEnd, is_active: true });
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: leaseId, type: 'term_extended', tenant_name: lease?.tenant_name || null,
      description: `Term extended to ${fmtDate(changes.extensionEnd)}${addendum.label ? ` (${addendum.label})` : ''}`,
      event_date: addendum.amendment_date || null, meta: { addendum_id: addendum.id, new_end: changes.extensionEnd },
    });
  }

  // Assignment / change of tenant — swap the tenant identity on the lease as of the
  // effective date, and keep the prior tenant in the building's history log.
  if (changes.assignment && changes.assignment.newTenantName) {
    const a = changes.assignment;
    const priorTenant = lease?.tenant_name || null;
    await updateLease(leaseId, {
      tenant_name: a.newTenantName,
      tenant_contact_name: a.newTenantContact || null,
      tenant_email: a.newTenantEmail || null,
      tenant_email_2: a.newTenantEmail2 || null,
    });
    await logHistoryEvent({
      property_id: lease?.property_id || null,
      lease_id: leaseId,
      type: 'tenant_assigned',
      tenant_name: a.newTenantName, // the tenant the lease becomes going forward
      description: `Tenant changed: ${priorTenant || '—'} → ${a.newTenantName}`,
      event_date: a.effectiveDate || addendum.amendment_date || null,
      meta: { prior_tenant: priorTenant, new_tenant: a.newTenantName, contact: a.newTenantContact || null, addendum_id: addendum.id },
    });
  }

  // Renewal options contributed by the rider — pending rights, term-neutral until
  // the landlord confirms them (confirmRenewal).
  const renRows = buildRenewals(changes.renewals);
  if (renRows.length) {
    await rows(
      supabase.from('renewal_options').insert(
        renRows.map((r) => ({ ...r, lease_id: leaseId, owner_id: uid, status: 'pending', addendum_id: addendum.id }))
      )
    );
  }

  // Rent abatements the rider grants (free / reduced base-rent windows). Term-neutral:
  // they net rent out of the invoices + monthly tracker but never touch base_rent.
  const abRows = buildAbatements(changes.abatements);
  if (abRows.length) {
    await rows(
      supabase.from('rent_abatements').insert(
        abRows.map((a) => ({ ...a, lease_id: leaseId, owner_id: uid, addendum_id: addendum.id }))
      )
    );
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: leaseId, type: 'rent_abated', tenant_name: lease?.tenant_name || null,
      description: `Rent abatement added${addendum.label ? ` (${addendum.label})` : ''}: ${abRows.length} window${abRows.length > 1 ? 's' : ''} (${fmtDate(abRows[0].start_date)} – ${fmtDate(abRows[abRows.length - 1].end_date)})`,
      event_date: addendum.amendment_date || abRows[0].start_date || null, meta: { addendum_id: addendum.id, windows: abRows },
    });
  }

  return backfillLeaseToToday(leaseId, today);
}

// ---- Expense records (Page 2, per year) ------------------------------------
export const getExpenseRecord = (propertyId, year) =>
  one(
    supabase
      .from('expense_records')
      .select('*')
      .eq('property_id', propertyId)
      .eq('year', year)
      .maybeSingle()
  );

export const upsertExpenseRecord = async ({ property_id, year, taxes_total, cam_total, roof_total }) =>
  one(
    supabase
      .from('expense_records')
      .upsert(
        { property_id, year, taxes_total, cam_total, roof_total, owner_id: await ownerId() },
        { onConflict: 'property_id,year' }
      )
      .select()
      .single()
  );

// ---- CAM line items (itemized CAM that auto-sums) --------------------------
export const listCamLineItems = (propertyId, year) =>
  rows(
    supabase
      .from('cam_line_items')
      .select('*')
      .eq('property_id', propertyId)
      .eq('year', year)
      .order('created_at')
  );

// Re-sum the line items and write the total into expense_records.cam_total,
// preserving taxes/roof. This is the "adds everything up" step — pure code.
async function syncCamTotal(propertyId, year) {
  const items = await listCamLineItems(propertyId, year);
  const camSum = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const existing = await getExpenseRecord(propertyId, year);
  await upsertExpenseRecord({
    property_id: propertyId,
    year,
    taxes_total: existing?.taxes_total ?? 0,
    cam_total: camSum,
    roof_total: existing?.roof_total ?? 0,
  });
  return camSum;
}

export async function addCamLineItem({ property_id, year, label, amount }) {
  await one(
    supabase
      .from('cam_line_items')
      .insert({ property_id, year, label, amount, owner_id: await ownerId() })
      .select()
      .single()
  );
  return syncCamTotal(property_id, year);
}

export async function deleteCamLineItem(id, propertyId, year) {
  await rows(supabase.from('cam_line_items').delete().eq('id', id));
  return syncCamTotal(propertyId, year);
}

// Auto-carry service contracts into CAM for a given fiscal year: one CAM line item per
// covering contract, at its escalated annual cost (contract_id links them). Creating,
// refreshing a drifted amount/label, and removing rows whose contract no longer covers
// the year are all handled here — so a multi-year contract needs no re-entry when a new
// fiscal year opens; viewing the year self-heals it. Idempotent: writes only on a real
// change, then re-sums the CAM total. Mirrors src/lib/contracts.js.
export async function syncContractCamItems(propertyId, year) {
  const uid = await ownerId();
  const [contracts, items] = await Promise.all([
    listServiceContracts(propertyId),
    listCamLineItems(propertyId, year),
  ]);
  const autoByContract = new Map();
  for (const it of items) if (it.contract_id) autoByContract.set(it.contract_id, it);

  const covering = contracts.filter((c) => contractCoversYear(c, year) && contractAnnualCost(c, year) > 0);
  const coveringIds = new Set(covering.map((c) => c.id));
  let changed = false;

  for (const c of covering) {
    const amount = contractAnnualCost(c, year);
    const label = c.name || c.vendor || 'Service contract';
    const existing = autoByContract.get(c.id);
    if (!existing) {
      await one(supabase.from('cam_line_items').insert({ property_id: propertyId, year, label, amount, contract_id: c.id, owner_id: uid }).select().single());
      changed = true;
    } else if (Number(existing.amount) !== amount || existing.label !== label) {
      await one(supabase.from('cam_line_items').update({ amount, label }).eq('id', existing.id).select().single());
      changed = true;
    }
  }
  // Remove auto rows whose contract no longer covers this year (term change / made one-time).
  for (const [cid, it] of autoByContract) {
    if (!coveringIds.has(cid)) { await rows(supabase.from('cam_line_items').delete().eq('id', it.id)); changed = true; }
  }

  if (changed) return syncCamTotal(propertyId, year);
  return items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
}

// ---- Computed views ---------------------------------------------------------
export const getPropertyTotals = (propertyId, year) =>
  one(
    supabase
      .from('v_property_totals')
      .select('*')
      .eq('property_id', propertyId)
      .eq('year', year)
      .maybeSingle()
  );

// Bulk: financial totals for a set of properties for a year in ONE query.
// Lets a financials property list load every card's totals at once (no waterfall).
// Returns a map { [propertyId]: totalsRow } (only properties that have a row).
export async function listPropertyTotalsByYear(propertyIds, year) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const all = await rows(
    supabase.from('v_property_totals').select('*').in('property_id', ids).eq('year', year)
  );
  const byProp = {};
  for (const t of all || []) byProp[t.property_id] = t;
  return byProp;
}

export const getTenantShares = (propertyId, year) =>
  rows(
    supabase.from('v_tenant_shares').select('*').eq('property_id', propertyId).eq('year', year)
  );

// ---- Invoices & payments (AR) ----------------------------------------------
// Invoices read from v_invoice_balances (carries derived amount_paid/balance/
// display_status); writes go to the base invoices/payments tables.
export const listInvoices = (leaseId) =>
  rows(supabase.from('v_invoice_balances').select('*').eq('lease_id', leaseId).order('issue_date', { ascending: false }));

export const listInvoicesForProperty = (propertyId) =>
  rows(supabase.from('v_invoice_balances').select('*').eq('property_id', propertyId).order('issue_date', { ascending: false }));

export const createInvoice = async (inv) =>
  one(supabase.from('invoices').insert({ ...inv, owner_id: await ownerId() }).select().single());

export const updateInvoice = (id, patch) =>
  one(supabase.from('invoices').update(patch).eq('id', id).select().single());

export const deleteInvoice = (id) => rows(supabase.from('invoices').delete().eq('id', id));

export const listPayments = (invoiceId) =>
  rows(supabase.from('payments').select('*').eq('invoice_id', invoiceId).order('paid_date'));

export const recordPayment = async (pay) =>
  one(supabase.from('payments').insert({ ...pay, owner_id: await ownerId() }).select().single());

export const deletePayment = (id) => rows(supabase.from('payments').delete().eq('id', id));

// ---- Monthly rent tracker ---------------------------------------------------
// The per-lease 12-box grid and the property rent roll are a friendly MONTHLY
// layer over the SAME annual invoices/payments. "Month paid" = one payment row
// tagged with period_month (1-12) against that year's invoice. The year's invoice
// is created on demand the first time a month is marked (no manual invoice step),
// using the exact figures the manual invoice flow uses (draft-invoice). Because
// each fiscal year has its own invoice, switching years shows a fresh grid and
// prior years stay intact — that's the per-year "reset".
const paymentIsoToday = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// The live (non-void) invoice for a lease + year, or null.
export async function getYearInvoice(leaseId, year) {
  const list = await listInvoices(leaseId);
  return list.find((i) => Number(i.year) === Number(year) && i.status !== 'void') || null;
}

// Ensure a 'sent' invoice exists for (lease, year), creating it from the same
// draft-invoice figures the manual flow uses so it is identical. Returns the invoice.
export async function ensureInvoice(leaseId, propertyId, year) {
  const existing = await getYearInvoice(leaseId, year);
  if (existing) return existing;
  const { facts } = await invokeFunction('draft-invoice', { lease_id: leaseId, year });
  const base = Number(facts?.base_rent_annual || 0);
  const cam = Number(facts?.cam_annual || 0);
  const tax = Number(facts?.tax_annual || 0);
  const roof = Number(facts?.roof_annual || 0);
  const abatement = Number(facts?.abatement_annual || 0); // free/reduced base rent netted out
  return createInvoice({
    lease_id: leaseId,
    property_id: propertyId,
    year: Number(year),
    issue_date: facts?.today || null,
    due_date: facts?.due || null,
    status: 'sent',
    base_rent_annual: base,
    cam_annual: cam,
    tax_annual: tax,
    roof_annual: roof,
    abatement_annual: abatement,
    total_amount: Math.max(0, base + cam + tax + roof - abatement),
  });
}

// Everything the monthly grid needs for one lease + year in one call: the year's
// invoice (or null), the expected annual/monthly amount, and which months are paid
// (period_month -> { amount, ids, paid_date, method }).
export async function getMonthlyRent(leaseId, year) {
  const [invoice, abatements] = await Promise.all([getYearInvoice(leaseId, year), listAbatements(leaseId)]);
  // GROSS base + other charges for the year — the abatement is applied per-month below,
  // not baked into these, so the tracker can show which specific months are free.
  let grossBase = 0;
  let other = 0;
  if (invoice) {
    grossBase = Number(invoice.base_rent_annual || 0);
    other = Number(invoice.cam_annual || 0) + Number(invoice.tax_annual || 0) + Number(invoice.roof_annual || 0);
  } else {
    const { facts } = await invokeFunction('draft-invoice', { lease_id: leaseId, year });
    grossBase = Number(facts?.base_rent_annual || 0);
    other = Number(facts?.cam_annual || 0) + Number(facts?.tax_annual || 0) + Number(facts?.roof_annual || 0);
  }
  // Per-month expected owed (full charges minus any base abatement). The net annual is
  // the sum — so the collected/remaining math nets out the free months automatically.
  const schedule = monthlyScheduleForYear({ year, annualBaseRent: grossBase, otherAnnual: other, abatements });
  const annual = Object.values(schedule).reduce((s, c) => s + c.owed, 0);

  const payments = invoice ? await listPayments(invoice.id) : [];
  const byMonth = {};
  for (const p of payments) {
    const m = Number(p.period_month);
    if (!m) continue; // skip untagged (annual/partial) payments
    const b = (byMonth[m] ||= { amount: 0, ids: [], paid_date: p.paid_date, method: p.method });
    b.amount += Number(p.amount) || 0;
    b.ids.push(p.id);
  }
  return { invoice, annual, monthly: annual / 12, byMonth, schedule, hasAbatement: (abatements || []).length > 0 };
}

// Mark month (1-12) paid: ensure the year's invoice exists, then record a payment
// tagged with that month. amount defaults to the monthly share (invoice total / 12).
export async function markMonthPaid(leaseId, propertyId, year, month, opts = {}) {
  const invoice = await ensureInvoice(leaseId, propertyId, year);
  let amount;
  if (opts.amount != null && opts.amount !== '') {
    amount = Number(opts.amount);
  } else {
    // Default to that month's expected owed, net of any base-rent abatement — NOT a flat
    // total/12 (which would over-bill during free months and under-bill the rest).
    const abatements = await listAbatements(leaseId);
    const grossBase = Number(invoice.base_rent_annual || 0);
    const other = Number(invoice.cam_annual || 0) + Number(invoice.tax_annual || 0) + Number(invoice.roof_annual || 0);
    const sched = monthlyScheduleForYear({ year, annualBaseRent: grossBase, otherAnnual: other, abatements });
    amount = sched[Number(month)]?.owed ?? (Number(invoice.total_amount || 0) / 12);
  }
  // Nothing due this month (fully-free base and no other charges) — don't record a $0
  // payment; the month simply shows "Free". An explicit amount override still records.
  if (!(amount > 0) && (opts.amount == null || opts.amount === '')) return invoice;
  await recordPayment({
    invoice_id: invoice.id,
    lease_id: leaseId,
    amount,
    paid_date: opts.paid_date || paymentIsoToday(),
    method: opts.method || 'check',
    note: opts.note || null,
    period_month: Number(month),
  });
  return invoice;
}

// Undo a month: delete every payment tagged with that month on the year's invoice.
export async function unmarkMonthPaid(leaseId, year, month) {
  const invoice = await getYearInvoice(leaseId, year);
  if (!invoice) return;
  const payments = await listPayments(invoice.id);
  for (const p of payments.filter((x) => Number(x.period_month) === Number(month))) {
    await deletePayment(p.id);
  }
}

// Bulk: mark `month` paid for every tenant in a property that hasn't paid it yet
// (for `year`). Idempotent — tenants already marked for that month are skipped.
// Returns { paid, skipped, total }.
export async function markMonthPaidAllTenants(propertyId, year, month, opts = {}) {
  const shares = await getTenantShares(propertyId, year); // one row per active tenant/lease for the year
  let paid = 0;
  let skipped = 0;
  for (const s of shares) {
    const invoice = await getYearInvoice(s.lease_id, year);
    if (invoice) {
      const payments = await listPayments(invoice.id);
      if (payments.some((p) => Number(p.period_month) === Number(month))) { skipped++; continue; }
    }
    await markMonthPaid(s.lease_id, propertyId, year, month, opts);
    paid++;
  }
  return { paid, skipped, total: shares.length };
}

// Property rent roll: one row per tenant for `year` with their monthly amount and
// which months are paid — powers the property-level grid + "mark all paid". Uses
// the year's invoice total/12 when an invoice exists, else an estimate from the
// tenant-share figures (exact once the first month is marked and the invoice is born).
export async function getPropertyMonthlyRoll(propertyId, year) {
  const [shares, invoices] = await Promise.all([
    getTenantShares(propertyId, year),
    listInvoicesForProperty(propertyId),
  ]);
  const abByLease = await listAbatementsForLeases(shares.map((s) => s.lease_id));
  const invByLease = {};
  for (const inv of invoices) {
    if (Number(inv.year) === Number(year) && inv.status !== 'void') invByLease[inv.lease_id] = inv;
  }
  const paymentsByInvoice = {};
  await Promise.all(
    Object.values(invByLease).map(async (inv) => { paymentsByInvoice[inv.id] = await listPayments(inv.id); })
  );
  return shares.map((s) => {
    const inv = invByLease[s.lease_id] || null;
    // GROSS base + other charges (abatement applied per-month via the schedule, not baked in).
    const grossBase = inv ? Number(inv.base_rent_annual || 0) : Number(s.base_rent || 0);
    const other = inv
      ? Number(inv.cam_annual || 0) + Number(inv.tax_annual || 0) + Number(inv.roof_annual || 0)
      : Number(s.cam_amount || 0) + Number(s.tax_amount || 0) + (s.roof_responsible ? Number(s.roof_amt || 0) : 0);
    const abatements = abByLease[s.lease_id] || [];
    const schedule = monthlyScheduleForYear({ year, annualBaseRent: grossBase, otherAnnual: other, abatements });
    const annual = Object.values(schedule).reduce((sum, c) => sum + c.owed, 0);
    const byMonth = {};
    if (inv) {
      for (const p of paymentsByInvoice[inv.id] || []) {
        const m = Number(p.period_month);
        if (!m) continue;
        (byMonth[m] ||= { amount: 0 }).amount += Number(p.amount) || 0;
      }
    }
    return { lease_id: s.lease_id, tenant_name: s.tenant_name, annual, monthly: annual / 12, byMonth, schedule, hasAbatement: abatements.length > 0 };
  });
}

// Outstanding AR for a property (and a current/30/60/90+ aging by due date).
export async function getPropertyAR(propertyId, today = new Date()) {
  return summarizeAR(await listInvoicesForProperty(propertyId), today);
}

// Portfolio-wide AR (all of the owner's invoices) — powers the dashboard.
export async function getPortfolioAR(today = new Date()) {
  return summarizeAR(await rows(supabase.from('v_invoice_balances').select('*')), today);
}

// Sum the still-owed balance across live (non-void, non-draft) invoices, bucketed
// by how overdue each is. Pure code — mirrors what an accountant calls AR aging.
function summarizeAR(invoices, today = new Date()) {
  const owing = (invoices || []).filter((i) => i.display_status !== 'void' && i.display_status !== 'draft' && Number(i.balance) > 0);
  const day = 86400000;
  const buckets = { current: 0, d30: 0, d60: 0, d90: 0 };
  let outstanding = 0;
  for (const i of owing) {
    const bal = Number(i.balance) || 0;
    outstanding += bal;
    const due = i.due_date ? new Date(i.due_date + 'T12:00:00') : null;
    const overdueDays = due ? Math.floor((today - due) / day) : 0;
    if (overdueDays <= 0) buckets.current += bal;
    else if (overdueDays <= 30) buckets.d30 += bal;
    else if (overdueDays <= 60) buckets.d60 += bal;
    else buckets.d90 += bal;
  }
  return { outstanding, count: owing.length, buckets };
}

// ---- Alerts (computed from lease key dates, portfolio-wide) -----------------
export async function fetchAlertData() {
  const [leasesR, escR, renR, propR, insR, conR] = await Promise.all([
    supabase.from('leases').select('id,tenant_name,property_id,lease_termination_date,no_renewal_option,is_active'),
    supabase.from('rent_escalations').select('lease_id,effective_date,status'),
    supabase.from('renewal_options').select('id,lease_id,notice_by_date,status'),
    supabase.from('properties').select('id,name,corporation_id'),
    supabase.from('insurance_policies').select('party,property_id,lease_id,insurer,expiry_date').is('archived_at', null),
    supabase.from('service_contracts').select('id,name,vendor,vendor_email,end_date,property_id'),
  ]);
  return {
    leases: leasesR.data || [],
    escalations: escR.data || [],
    renewals: renR.data || [],
    properties: propR.data || [],
    insurance: insR.data || [],
    contracts: conR.data || [],
  };
}

// ---- Alert states (server-synced dismiss / snooze for computed alerts) ------
export const listAlertStates = () =>
  rows(supabase.from('alert_states').select('alert_key,dismissed,snoozed_until'));

// Upsert one alert's state. `patch` carries alert_key plus { dismissed } or
// { snoozed_until }; un-passed columns are left untouched on an existing row.
export const upsertAlertState = async (patch) =>
  one(
    supabase
      .from('alert_states')
      .upsert({ ...patch, owner_id: await ownerId() }, { onConflict: 'owner_id,alert_key' })
      .select()
      .single()
  );

// ---- Dashboard display preferences (which Overview widgets are hidden) ------
// One row per user, client-writable under RLS (migration 0038). Reading defaults
// to "nothing hidden" on any error or for a fresh account, so the dashboard shows
// everything until the landlord chooses otherwise.
export async function getHiddenWidgets() {
  try {
    const uid = await ownerId();
    if (!uid) return [];
    const { data } = await supabase
      .from('user_preferences')
      .select('hidden_widgets')
      .eq('user_id', uid)
      .maybeSingle();
    return data?.hidden_widgets || [];
  } catch {
    return [];
  }
}

// Replace the full set of hidden widget keys for the current user.
export const setHiddenWidgets = async (hidden_widgets) =>
  one(
    supabase
      .from('user_preferences')
      .upsert(
        { user_id: await ownerId(), hidden_widgets, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select()
      .single()
  );

// ---- Enabled feature modules (the opt-in switchboard) -----------------------
// Same user_preferences row as the widget prefs (column enabled_features, migration
// 0043). Returns null when the user has never chosen — the caller uses that to show
// the one-time onboarding picker and to treat everything as on until they decide.
// An array is the explicit set of optional modules they want on. Never returns
// undefined (React Query forbids it); null is a valid, meaningful value here.
export async function getEnabledFeatures() {
  try {
    const uid = await ownerId();
    if (!uid) return null;
    const { data } = await supabase
      .from('user_preferences')
      .select('enabled_features')
      .eq('user_id', uid)
      .maybeSingle();
    return data?.enabled_features ?? null;
  } catch {
    return null;
  }
}

// Replace the full set of enabled feature keys for the current user.
export const setEnabledFeatures = async (enabled_features) =>
  one(
    supabase
      .from('user_preferences')
      .upsert(
        { user_id: await ownerId(), enabled_features, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select()
      .single()
  );

// ---- Notifications ----------------------------------------------------------
export const listNotifications = () =>
  rows(supabase.from('notifications').select('*').order('created_at', { ascending: false }));

export const markNotificationRead = (id) =>
  one(supabase.from('notifications').update({ read: true }).eq('id', id).select().single());

// Dismiss (clear) a notification entirely.
export const dismissNotification = (id) =>
  rows(supabase.from('notifications').delete().eq('id', id));

// ---- Lease renewals (landlord-confirmed, never automatic) -------------------
// A renewal option is the tenant's *right* to extend — it is NEVER applied on its
// own. The flow is: promptDueRenewalDecisions() drops a one-time "Is the tenant
// renewing?" notification when a decision is due; the landlord answers Yes/No;
// confirmRenewal() (Yes) rolls the lease into the new term, or declineRenewal() (No)
// closes the option. This replaced the old auto-apply, which silently extended terms.

// When is a renewal decision "due"? The window opens at the option's notice-by date
// if the lease states one, else ~6 months before the committed term end, and stays
// open until the term has lapsed.
function isRenewalDecisionDue(lease, ren, today = new Date()) {
  const termEnd = lease?.lease_termination_date;
  if (!termEnd) return false;
  const todayIso = today.toISOString().slice(0, 10);
  // Once the committed term has ended, the option lapsed unexercised — stop asking.
  if (termEnd < todayIso) return false;
  // The prompt opens a bit before the deadline: at the option's notice-by date if the
  // lease states one, else ~6 months before the committed term end. It stays open only
  // through the decision window (up to term end).
  const trigger = ren?.notice_by_date || addMonths(termEnd, -6);
  return trigger ? todayIso >= trigger : false;
}

// Roll a lease into a confirmed renewal option. The new term begins where the current
// one ends (newStart = today's committed end); how we apply it depends on WHEN that is:
//
//  • The window has already BEGUN (a past/lapsed option, or one whose start is today or
//    earlier) → catch the lease up: archive the prior term, move lease_start to the new
//    start, set base_rent to the new first-year rent, materialize any +%/yr step-ups.
//    (Chaining a lapsed option forward, as the other session designed.)
//  • The window is still in the FUTURE (confirming an option early) → do NOT touch
//    lease_start or today's base_rent — just extend lease_termination_date to the new
//    end and drop the option's rent in as DATED escalation steps so it takes effect on
//    its start date. (Moving lease_start into the future was the old bug that made the
//    page look unchanged and wiped today's rent.)
//
// Pure code — no email/notification. Returns the figures + business so the caller can
// build the tenant email. Shared by confirmRenewal.
async function rollLeaseIntoRenewal(lease, ren, uid, corpCache = new Map(), newRentOverride = null, today = new Date()) {
  const newStart = lease.lease_termination_date;              // new term begins as the old one ends
  const newEnd = addMonths(lease.lease_termination_date, ren.term_months || 12);
  const oldRent = Number(lease.base_rent) || 0;
  // First renewal-year rent, in precedence: a figure the landlord typed at renewal
  // (options whose rent the lease left open — "fair market value" etc.) wins; else the
  // option's own explicit new_rent; else apply the annual % to the prior rent; else
  // carry the prior rent.
  const pct = Number(ren.annual_escalation_pct) || 0;
  const newRent = newRentOverride != null && Number(newRentOverride) > 0
    ? round2(Number(newRentOverride))
    : ren.new_rent != null ? Number(ren.new_rent) : (pct > 0 ? round2(oldRent * (1 + pct / 100)) : oldRent);
  const prop = await getProperty(lease.property_id);
  if (prop?.corporation_id && !corpCache.has(prop.corporation_id)) {
    corpCache.set(prop.corporation_id, await getCorporation(prop.corporation_id));
  }
  const business = businessFromCorp(prop?.corporation_id ? corpCache.get(prop.corporation_id) : null);

  const todayIso = today.toISOString().slice(0, 10);
  const years = Math.max(1, Math.round((ren.term_months || 12) / 12));
  // Has the option's term window already started? (No end date on file → treat as begun.)
  const hasBegun = !newStart || String(newStart) <= todayIso;

  if (hasBegun) {
    // ---- Past / due option: catch the lease up to the new term. ----
    // 1) archive the prior term into the History "expired & renewed" log
    await rows(
      supabase.from('expired_leases').insert({
        owner_id: uid,
        property_id: lease.property_id,
        tenant_name: lease.tenant_name,
        sf: lease.square_footage,
        base_rent: oldRent,
        lease_start: lease.lease_start,
        lease_end: lease.lease_termination_date,
        status: 'Renewed',
        note: `Renewed (${ren.option_label || 'renewal option'}) — new term through ${fmtDate(newEnd)}`,
        lease_text: lease.lease_text ?? null,
      })
    );
    // 2) roll the live lease into the new term + rent
    await updateLease(lease.id, { lease_start: newStart, lease_termination_date: newEnd, base_rent: newRent, is_active: true });
    // 3b) materialize the option's annual step-ups (years 2..N) as scheduled escalations
    // so a "+pct%/yr" option becomes real, dated rent steps (year 1 is the new base rent).
    if (pct > 0 && newStart) {
      const escRows = [];
      for (let y = 1; y < years; y++) {
        escRows.push({
          lease_id: lease.id,
          owner_id: uid,
          effective_date: addMonths(newStart, y * 12),
          escalation_type: 'percent',
          escalation_value: pct,
          new_base_rent: round2(newRent * Math.pow(1 + pct / 100, y)),
          status: 'scheduled',
        });
      }
      if (escRows.length) await rows(supabase.from('rent_escalations').insert(escRows));
    }
  } else {
    // ---- Future option confirmed early: extend the term, leave today's rent alone. ----
    // Today's start + base rent are untouched; we only push the end out and lay the
    // option's rent in as dated steps that apply on their own dates.
    await updateLease(lease.id, { lease_termination_date: newEnd, is_active: true });

    // The imported schedule may already carry these steps (leases that print every
    // year's rent, e.g. Ricki's) — skip a boundary that already has a step within 45
    // days so we never double-book it.
    const escs = await listEscalations(lease.id);
    const dated = escs.filter((e) => e.effective_date);
    const daysApart = (a, b) => Math.round(Math.abs(new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
    const hasStepNear = (iso) => dated.some((e) => daysApart(String(e.effective_date), iso) <= 45);
    const escRows = [];
    for (let y = 0; y < years; y++) {
      if (y >= 1 && pct <= 0) break;                 // flat option → only the year-1 step matters
      const d = addMonths(newStart, y * 12);
      if (!d || hasStepNear(d)) continue;
      escRows.push({
        lease_id: lease.id,
        owner_id: uid,
        effective_date: d,
        escalation_type: y === 0 ? 'manual' : 'percent',
        escalation_value: y === 0 ? null : pct,
        new_base_rent: y === 0 ? newRent : round2(newRent * Math.pow(1 + pct / 100, y)),
        status: 'scheduled',
      });
    }
    if (escRows.length) await rows(supabase.from('rent_escalations').insert(escRows));
  }

  // Mark the option applied so it never re-runs. If the landlord typed the rent (the
  // lease left it open), record it on the option too so the row shows what was agreed.
  await updateRenewal(ren.id, {
    status: 'applied',
    applied_at: new Date().toISOString(),
    ...(newRentOverride != null && Number(newRentOverride) > 0 ? { new_rent: newRent } : {}),
  });

  return { newStart, newEnd, oldRent, newRent, business, prop };
}

// The landlord confirmed the tenant IS exercising a renewal option → apply it now,
// clear the open decision prompt, and drop a "renewed" notification carrying a
// ready-to-send tenant email. Returns that notification (or null if not applicable).
export async function confirmRenewal(renewalId, today = new Date(), opts = {}) {
  const uid = await ownerId();
  const ren = await one(supabase.from('renewal_options').select('*').eq('id', renewalId).maybeSingle());
  if (!ren || ren.status !== 'pending') return null;
  const lease = await getLease(ren.lease_id);
  if (!lease) return null;

  const { newStart, newEnd, oldRent, newRent, business, prop } = await rollLeaseIntoRenewal(lease, ren, uid, new Map(), opts.newRent, today);

  await logHistoryEvent({
    property_id: lease.property_id, lease_id: lease.id, type: 'renewal_confirmed', tenant_name: lease.tenant_name,
    description: `Renewal confirmed${ren.option_label ? ` (${ren.option_label})` : ''} — term extended to ${fmtDate(newEnd)} at ${money(newRent)}`,
    event_date: null, meta: { renewal_id: ren.id },
  });

  // clear the "Is the tenant renewing?" prompt for this lease
  await rows(supabase.from('notifications').delete().eq('lease_id', lease.id).eq('kind', 'renewal_decision'));

  const email = buildRenewalEmail({
    business,
    tenant_name: lease.tenant_name,
    contact_name: lease.tenant_contact_name,
    tenant_email: lease.tenant_email,
    propertyName: prop?.name,
    newStart, newEnd, oldRent, newRent,
  });
  const notif = await one(
    supabase
      .from('notifications')
      .insert({
        owner_id: uid,
        lease_id: lease.id,
        property_id: lease.property_id,
        corporation_id: prop?.corporation_id,
        kind: 'renewal_applied',
        title: `Lease renewed — ${lease.tenant_name}`,
        body: `Term extended to ${fmtDate(newEnd)} · base rent now ${money(newRent)}`,
        email_to: lease.tenant_email || null,
        email_to_2: lease.tenant_email_2 || null,
        email_from: business?.contact_email || null,
        email_subject: email.subject,
        email_body: email.body,
        read: false,
      })
      .select()
      .single()
  );
  await backfillLeaseToToday(lease.id, today);
  return notif;
}

// The landlord confirmed the tenant is NOT renewing → mark the option declined, clear the
// prompt, and drop a "not renewing" notification carrying a ready-to-send lease-end notice.
// The lease runs out its committed term and goes outdated normally.
export async function declineRenewal(renewalId) {
  const uid = await ownerId();
  const ren = await one(supabase.from('renewal_options').select('lease_id, option_label').eq('id', renewalId).maybeSingle());
  await updateRenewal(renewalId, { status: 'declined', applied_at: new Date().toISOString() });
  if (ren?.lease_id) {
    const lease = await getLease(ren.lease_id);
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: ren.lease_id, type: 'renewal_declined', tenant_name: lease?.tenant_name || null,
      description: `Renewal not exercised${ren.option_label ? ` (${ren.option_label})` : ''} — tenant is not renewing`,
      event_date: null, meta: { renewal_id: renewalId },
    });
    await rows(supabase.from('notifications').delete().eq('lease_id', ren.lease_id).eq('kind', 'renewal_decision'));

    if (lease) {
      const prop = await getProperty(lease.property_id);
      const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
      const email = buildNonRenewalEmail({
        business,
        tenant_name: lease.tenant_name,
        contact_name: lease.tenant_contact_name,
        tenant_email: lease.tenant_email,
        propertyName: prop?.name,
        leaseEnd: lease.lease_termination_date,
      });
      await rows(
        supabase.from('notifications').insert({
          owner_id: uid,
          lease_id: lease.id,
          property_id: lease.property_id,
          corporation_id: prop?.corporation_id || null,
          kind: 'renewal_declined',
          title: `Lease not renewing — ${lease.tenant_name}`,
          body: `Term ends ${fmtDate(lease.lease_termination_date)} and will not be renewed. Send the tenant a lease-end notice.`,
          email_to: lease.tenant_email || null,
          email_to_2: lease.tenant_email_2 || null,
          email_from: business?.contact_email || null,
          email_subject: email.subject,
          email_body: email.body,
          read: false,
        })
      );
    }
  }
}

// Undo a decline — put a "not renewing" option back to pending so the decision can be
// made again (e.g. it was clicked by mistake). Reverses declineRenewal, and re-raises the
// "Is the tenant renewing?" prompt if the decision is still due (declining had deleted it).
export async function restoreRenewal(renewalId) {
  const ren = await one(supabase.from('renewal_options').select('lease_id').eq('id', renewalId).maybeSingle());
  await updateRenewal(renewalId, { status: 'pending', applied_at: null });
  if (ren?.lease_id) {
    const lease = await getLease(ren.lease_id);
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: ren.lease_id, type: 'renewal_reopened', tenant_name: lease?.tenant_name || null,
      description: 'Renewal decision reopened (undo) — option is pending again',
      event_date: null, meta: { renewal_id: renewalId },
    });
    // Drop the stale "not renewing" notice so its lease-end email can't be sent by mistake.
    await rows(supabase.from('notifications').delete().eq('lease_id', ren.lease_id).eq('kind', 'renewal_declined'));
  }
  // Recreate the decision prompt if it's due (dedupes if one already exists).
  await promptDueRenewalDecisions();
}

// Bell-action helpers: a decision prompt only carries a lease_id, and there is at
// most one open decision per lease (its first pending option), so resolve that here.
export async function confirmRenewalForLease(leaseId, today = new Date(), opts = {}) {
  const pending = await rows(
    supabase.from('renewal_options').select('*').eq('lease_id', leaseId).eq('status', 'pending').order('notice_by_date')
  );
  if (!pending.length) { await rows(supabase.from('notifications').delete().eq('lease_id', leaseId).eq('kind', 'renewal_decision')); return null; }
  const opt = pending[0];
  // If the option states no rent (lease left it open) and the caller hasn't supplied one
  // yet, don't apply blind — tell the caller to collect the agreed new base rent first.
  const hasRent = opt.new_rent != null || Number(opt.annual_escalation_pct) > 0;
  if (!hasRent && opts.newRent == null) return { needsRent: true, renewalId: opt.id };
  return confirmRenewal(opt.id, today, { newRent: opts.newRent });
}
export async function declineRenewalForLease(leaseId) {
  const pending = await rows(
    supabase.from('renewal_options').select('*').eq('lease_id', leaseId).eq('status', 'pending').order('notice_by_date')
  );
  if (pending.length) { await declineRenewal(pending[0].id); return pending[0].id; }
  await rows(supabase.from('notifications').delete().eq('lease_id', leaseId).eq('kind', 'renewal_decision'));
  return null;
}

// Build the "renewal approaching" tenant email for a pending option as a ready-to-send
// draft (no notification created). Lets the lease page offer an "Email tenant" button so
// the landlord can send the heads-up ANY time — not only when the bell decision is due.
// Returns the email fields the send modal expects, or null if the option/lease is gone.
export async function draftRenewalApproachingEmail(renewalId) {
  const ren = await one(supabase.from('renewal_options').select('*').eq('id', renewalId).maybeSingle());
  if (!ren) return null;
  const lease = await getLease(ren.lease_id);
  if (!lease) return null;
  const prop = await getProperty(lease.property_id);
  const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
  const email = buildRenewalApproachingEmail({
    business,
    tenant_name: lease.tenant_name,
    contact_name: lease.tenant_contact_name,
    tenant_email: lease.tenant_email,
    propertyName: prop?.name,
    termEnd: lease.lease_termination_date,
    optionLabel: ren.option_label,
    termMonths: ren.term_months,
    newRent: ren.new_rent,
    escalationPct: Number(ren.annual_escalation_pct) || 0,
    noticeByDate: ren.notice_by_date,
  });
  return {
    kind: 'renewal_approaching',
    email_to: lease.tenant_email || '',
    email_to_2: lease.tenant_email_2 || '',
    email_from: business?.contact_email || '',
    email_subject: email.subject,
    email_body: email.body,
  };
}

// Build a ready-to-send email for a computed reminder (alert), so every reminder on the
// dashboard can carry a "✉ Email" button with the right pre-written letter. Returns the
// send-modal fields, or null when the alert has no outside recipient (e.g. the landlord's
// own building insurance policy). Mirrors draftRenewalApproachingEmail's return shape.
export async function draftAlertEmail(alert) {
  if (!alert) return null;
  const focus = alert.focus;

  // Contract expiry → a vendor renewal note (no lease involved).
  if (focus === 'contract') {
    const contract = await one(supabase.from('service_contracts').select('*').eq('id', alert.contract_id).maybeSingle());
    if (!contract) return null;
    const prop = contract.property_id ? await getProperty(contract.property_id) : null;
    const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
    const email = buildContractRenewalEmail({
      business,
      vendorName: contract.vendor || contract.name,
      vendorEmail: contract.vendor_email,
      contractName: contract.name || contract.vendor,
      propertyName: prop?.name,
      endDate: contract.end_date,
    });
    return { kind: 'contract_renewal', email_to: contract.vendor_email || '', email_to_2: '', email_from: business?.contact_email || '', email_subject: email.subject, email_body: email.body };
  }

  // A renewal-notice alert reuses the "approaching" draft (the alert carries the option id).
  if (focus === 'renewal' && alert.renewal_id) return draftRenewalApproachingEmail(alert.renewal_id);

  // Everything else is lease-scoped. The landlord's own insurance alert has no lease_id
  // (and no outside recipient), so it falls out here with null — no email button.
  if (!alert.lease_id) return null;
  const lease = await getLease(alert.lease_id);
  if (!lease) return null;
  const prop = await getProperty(lease.property_id);
  const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
  const common = { business, tenant_name: lease.tenant_name, contact_name: lease.tenant_contact_name, tenant_email: lease.tenant_email, propertyName: prop?.name };
  const wrap = (email, kind) => ({ kind, email_to: lease.tenant_email || '', email_to_2: lease.tenant_email_2 || '', email_from: business?.contact_email || '', email_subject: email.subject, email_body: email.body });

  if (focus === 'termination') return wrap(buildNonRenewalEmail({ ...common, leaseEnd: lease.lease_termination_date }), 'lease_ending');
  if (focus === 'insurance') return wrap(buildInsuranceRequestEmail({ ...common }), 'insurance_request');
  if (focus === 'escalation') {
    const escs = await listEscalations(lease.id);
    const esc = escs.find((e) => String(e.effective_date) === String(alert.date));
    const priorRent = priorRentBefore(lease, escs, alert.date);
    const newRent = esc?.new_base_rent != null ? Number(esc.new_base_rent) : priorRent;
    return wrap(buildEscalationEmail({ ...common, effectiveDate: alert.date, priorRent, newRent, escalationType: esc?.escalation_type, escalationValue: esc?.escalation_value }), 'escalation_notice');
  }
  return null;
}

// Sync a lease's renewal OPTIONS with the rent schedule it was imported with, so an
// option's lifecycle matches the dated escalations + term. Many leases (e.g. Ricki's)
// print rents for ALL years including the option periods, so the rent schedule keeps
// stepping right through option windows the tenant evidently exercised — yet the option
// rows stay "Pending" forever with no rent and no notice date, and a long-past option
// still shows Renew/Not-renewing. This reads the evidence and reconciles it:
//   • an option whose 5-year window has begun AND has a matching rent step at its start
//     is marked APPLIED (it was exercised — the rent proves it), its new_rent filled from
//     that step, and the committed term extended to cover it (never shrinking a date the
//     landlord entered). Logged as a silent history event — no emails.
//   • the first still-FUTURE option stays pending but gets its new_rent (from the scheduled
//     step at its start) and its notice_by_date computed from a "N days prior" notes clause.
//   • no rent evidence for a begun window → STOP (never guess a tenant renewed).
// Evidence-gated + idempotent. It ONLY runs on a clean AI-imported lease whose options are
// all still pending; once any option is applied/declined the manual confirm/decline flow
// (which moves lease_start) owns the lease and this bails, so window math can't drift.
export async function reconcileRenewalOptions(lease, today = new Date()) {
  if (!lease || lease.is_active === false || !lease.lease_start || !lease.lease_file_id) return false;
  const options = await rows(supabase.from('renewal_options').select('*').eq('lease_id', lease.id));
  if (options.length === 0 || !options.every((o) => o.status === 'pending')) return false;

  // The INITIAL (primary) term length, from the cached AI read on the linked file.
  const fileRows = await rows(
    supabase.from('lease_files').select('extraction_raw').eq('id', lease.lease_file_id).limit(1)
  );
  const initialTermMonths = Number(fileRows?.[0]?.extraction_raw?.term_months?.value) || 0;
  if (initialTermMonths <= 0) return false;

  const escs = await listEscalations(lease.id);
  const dated = escs.filter((e) => e.effective_date)
    .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
  const initialEnd = addMonths(lease.lease_start, initialTermMonths); // boundary = start of option 1
  // Evidence gate: the rent schedule actually continued past the initial term (else there's
  // nothing proving any option was exercised — leave everything alone).
  if (!initialEnd || !dated.some((e) => e.effective_date >= initialEnd)) return false;

  const toIso = (d) => d.toISOString().slice(0, 10);
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const daysApart = (a, b) => Math.round(Math.abs(new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
  // The rent step that STARTS a window (within ±45 days of the boundary), if any.
  const stepAt = (iso) => {
    let best = null, bestDiff = Infinity;
    for (const e of dated) {
      const diff = daysApart(e.effective_date, iso);
      if (diff <= 45 && diff < bestDiff) { best = e; bestDiff = diff; }
    }
    return best ? (Number(best.new_base_rent) || null) : null;
  };

  const todayIso = toIso(today);
  const ordered = [...options].sort(cmpRenewal);
  let windowStart = initialEnd;
  let termEnd = lease.lease_termination_date || null;

  for (const opt of ordered) {
    const months = Number(opt.term_months) || initialTermMonths;
    const windowEnd = addMonths(windowStart, months); // boundary (exclusive) — matches rollLeaseIntoRenewal
    const evidenceRent = stepAt(windowStart);

    if (windowStart <= todayIso) {
      // The option's window has begun (past or current). Only treat it as exercised when
      // the rent schedule actually stepped up at its start — otherwise STOP (never guess).
      if (evidenceRent == null) break;
      const patch = { status: 'applied', applied_at: new Date().toISOString() };
      if (opt.new_rent == null) patch.new_rent = evidenceRent;
      await updateRenewal(opt.id, patch);
      if (!termEnd || (windowEnd && windowEnd > termEnd)) termEnd = windowEnd; // extend, never shrink
      await logHistoryEvent({
        property_id: lease.property_id, lease_id: lease.id, type: 'renewal_confirmed', tenant_name: lease.tenant_name,
        description: `${opt.option_label || 'Renewal option'} exercised historically — reconciled from the rent schedule (rent ${money(evidenceRent)})`,
        event_date: null, meta: { renewal_id: opt.id, reconciled: true },
      });
      windowStart = windowEnd;
      continue;
    }

    // First still-future option: leave it PENDING, but fill the rent + notice date so it
    // reads correctly, then stop (later options depend on this one being exercised first).
    const patch = {};
    if (opt.new_rent == null && evidenceRent != null) patch.new_rent = evidenceRent;
    if (opt.notice_by_date == null) {
      const m = /(\d+)\s*days?\s*prior/i.exec(opt.notes || '');
      if (m && termEnd) patch.notice_by_date = addDays(termEnd, -Number(m[1])); // N days before the term then in effect
    }
    if (Object.keys(patch).length) await updateRenewal(opt.id, patch);
    break;
  }

  if (termEnd && termEnd !== lease.lease_termination_date) {
    await updateLease(lease.id, { lease_termination_date: termEnd });
  }
  return true;
}

// Scan active leases and, for each with a pending option whose decision is due and
// no prompt already open, drop a one-time 'renewal_decision' notification. Runs on
// app load (demo) and — at go-live — as the scheduled job (see migration 0034). It
// NEVER modifies the lease; only confirmRenewal does that.
export async function promptDueRenewalDecisions(today = new Date()) {
  const uid = await ownerId();
  const leases = await rows(supabase.from('leases').select('*'));
  const created = [];

  const todayIso = today.toISOString().slice(0, 10);
  for (const l of leases) {
    // Term already ended → any pending option lapsed unexercised. Clear a stale "Is the
    // tenant renewing?" prompt we dropped earlier and don't ask again. This runs BEFORE
    // the is_active check because a lapsed lease is typically already marked outdated.
    if (l.lease_termination_date && l.lease_termination_date < todayIso) {
      await rows(supabase.from('notifications').delete().eq('lease_id', l.id).eq('kind', 'renewal_decision'));
      continue;
    }
    if (l.is_active === false) continue; // outdated leases stay parked until an extension is added
    // Self-heal: sync this lease's options with its rent schedule first, so a historically
    // exercised option is marked applied (and won't prompt) and a future option carries its
    // real notice-by date. No-op for leases it doesn't apply to.
    const reconciled = await reconcileRenewalOptions(l, today);
    const lease = reconciled ? await getLease(l.id) : l;
    const pending = await rows(
      supabase.from('renewal_options').select('*').eq('lease_id', lease.id).eq('status', 'pending').order('notice_by_date')
    );
    const ren = pending[0];
    if (!ren || !isRenewalDecisionDue(lease, ren, today)) continue;

    // one open decision per lease at a time. Don't re-prompt if we already asked AND the
    // prompt already carries the tenant "renewal approaching" email; but DO enrich a bare
    // prompt (e.g. one the SQL cron dropped, which has no email) with that email.
    const existing = await rows(
      supabase.from('notifications').select('id, email_body').eq('lease_id', l.id).eq('kind', 'renewal_decision')
    );
    const bare = existing.find((n) => !n.email_body);
    if (existing.length && !bare) continue;

    // Build the "approaching" tenant email — needed to create a new prompt or enrich a bare one.
    const prop = await getProperty(l.property_id);
    const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
    const approachEmail = buildRenewalApproachingEmail({
      business,
      tenant_name: l.tenant_name,
      contact_name: l.tenant_contact_name,
      tenant_email: l.tenant_email,
      propertyName: prop?.name,
      termEnd: l.lease_termination_date,
      optionLabel: ren.option_label,
      termMonths: ren.term_months,
      newRent: ren.new_rent,
      escalationPct: Number(ren.annual_escalation_pct) || 0,
      noticeByDate: ren.notice_by_date,
    });
    const emailFields = {
      email_to: l.tenant_email || null,
      email_to_2: l.tenant_email_2 || null,
      email_from: business?.contact_email || null,
      email_subject: approachEmail.subject,
      email_body: approachEmail.body,
    };

    if (bare) {
      await rows(supabase.from('notifications').update(emailFields).eq('id', bare.id));
      continue;
    }

    const years = Math.round((ren.term_months || 12) / 12);
    const pct = Number(ren.annual_escalation_pct) || 0;
    const rentLabel = ren.new_rent != null ? money(ren.new_rent) : (pct > 0 ? `+${pct}%/yr` : 'the current rent');
    const notif = await one(
      supabase
        .from('notifications')
        .insert({
          owner_id: uid,
          lease_id: l.id,
          property_id: l.property_id,
          corporation_id: prop?.corporation_id || null,
          kind: 'renewal_decision',
          title: `Is ${l.tenant_name} renewing?`,
          body: `${ren.option_label || 'A renewal option'} — ${years}-yr extension at ${rentLabel}. Confirm only if the tenant is exercising it; it won't change the term until you do.`,
          ...emailFields,
          read: false,
        })
        .select()
        .single()
    );
    created.push(notif);
  }
  return created;
}

// ---- Snapshots (history) ----------------------------------------------------
export const listSnapshots = (propertyId) =>
  rows(
    supabase
      .from('financial_snapshots')
      .select('*')
      .eq('property_id', propertyId)
      .order('year')
  );

// Expired / renewed lease archive (History page).
export const listExpiredLeases = (propertyId) =>
  rows(supabase.from('expired_leases').select('*').eq('property_id', propertyId).order('lease_end', { ascending: false }));

// Remove an archived (expired/renewed) lease record from History permanently.
export const deleteExpiredLease = (id) =>
  rows(supabase.from('expired_leases').delete().eq('id', id));

// Freeze a year: compute current totals + per-tenant breakdown and store an
// immutable snapshot so History never recomputes against later edits.
export async function closeYear(propertyId, year) {
  const [totals, shares] = await Promise.all([
    getPropertyTotals(propertyId, year),
    getTenantShares(propertyId, year),
  ]);
  if (!totals) throw new Error('Enter expenses for this year before closing it.');

  const breakdown = shares.map((s) => ({
    tenant: s.tenant_name,
    square_footage: s.square_footage,
    base_rent: s.base_rent,
    share_pct: s.share_pct,
    tax_amount: s.tax_amount,
    cam_amount: s.cam_amount,
  }));

  return one(
    supabase
      .from('financial_snapshots')
      .upsert(
        {
          property_id: propertyId,
          year,
          owner_id: await ownerId(),
          total_revenue: totals.total_revenue,
          taxes_total: totals.taxes_total,
          cam_total: totals.cam_total,
          roof_total: totals.roof_total,
          total_sf: totals.total_sf,
          tax_psf: totals.tax_psf,
          cam_psf: totals.cam_psf,
          breakdown,
          snapshot_at: new Date().toISOString(),
        },
        { onConflict: 'property_id,year' }
      )
      .select()
      .single()
  );
}

// Reopen (undo) a closed year: remove its stored snapshot so it's no longer
// frozen in History. The live financials for that year are untouched.
export const reopenYear = (propertyId, year) =>
  rows(supabase.from('financial_snapshots').delete().eq('property_id', propertyId).eq('year', year));
