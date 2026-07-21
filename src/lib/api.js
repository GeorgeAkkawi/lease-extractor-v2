// Central data access. Every function is owner-scoped automatically by RLS.
// Pages call these via @tanstack/react-query; shared query keys mean a Page 1
// edit invalidates and refreshes Page 2.
import { supabase, invokeFunction, DEMO_MODE } from './supabaseClient';
import { money, fmtDate } from './format';
import { addMonths } from './renewals';
import { buildRenewalEmail, buildEscalationEmail, buildRenewalApproachingEmail, buildNonRenewalEmail, buildInsuranceRequestEmail, buildInsuranceRenewalRequestEmail, buildContractRenewalEmail, buildCamReconciliationEmail } from './emailTemplates';
import { reconcileFigures, billedComponents } from './reconciliation';
import { buildLeaseSchedule } from './leaseSchedule';
import { allocatePayments } from './ledger';
import { priorRentBefore, computeEscalatedRent } from './escalations';
import { resolveCurrentTerm, cmpRenewal } from './leaseTerm';
import { abatementEnd, leadingFreeMonths } from './abatement';
import { contractCoversYear, contractAnnualCost } from './contracts';
import { byTermEnd } from './leaseSearch';
import { buildPortfolioSnapshot, snapshotToText, snapshotFingerprint, normalizeQuestion } from './portfolio';
import { advanceDueDate } from './annualReports';

// An event is "recent" if its date is no more than this many days in the past.
// Back-dated catch-up only sends a tenant email / notification for recent events;
// purely-historical ones (e.g. an old lease entered today) apply silently.
const RECENT_DAYS = 31;
function isRecentDate(iso, today = new Date()) {
  if (!iso) return true;
  const days = (today.getTime() - new Date(iso + 'T12:00:00').getTime()) / 86400000;
  return days <= RECENT_DAYS;
}

// The app's "today" is the LANDLORD'S calendar date (the browser's local clock) —
// never the UTC date, which after ~8pm Eastern already reads tomorrow and made the
// on-load engine apply escalations / open renewal prompts a day early. Mirrors the
// database's app_today() (migration 0051).
export function localDateIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

// Call a Postgres function (RPC). Used for the money paths that must write several
// rows in ONE transaction (e.g. create_lease_tx) so a mid-write failure can't leave
// a half-built lease. Throws the raw supabase error (has .code) on failure.
async function callRpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
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

// Send a tenant letter directly from the app (the "Send now" button). Delivered by
// the verified amlakre.com domain, but the tenant sees the landlord's business name
// and replies go to replyTo (the corporation's business email). Landlord-initiated
// only — never auto-sends. Returns { id } from Resend on success; throws a friendly
// message (surfaced by invokeFunction) so the UI can point back at the Gmail button.
export function sendTenantEmail({ to, subject, body, replyTo }) {
  return invokeFunction('send-tenant-email', { to, subject, body, reply_to: replyTo || null });
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

// ---- Annual reports (one per corporation: state filing deadline) ------------
// One row per corporation, holding the next filing deadline + the documents on file.
export const getAnnualReport = (corporationId) =>
  one(supabase.from('annual_reports').select('*').eq('corporation_id', corporationId).maybeSingle());

// All annual-report records (for the dashboard alerts feed).
export const listAnnualReports = () =>
  rows(supabase.from('annual_reports').select('*'));

// Insert-or-update the annual-report row for one corporation. Changing the due date
// clears due_notice_bucket so the 1-month reminder email re-arms for the new date
// (mirrors saveInsurance's expiry_notice_bucket re-arm).
export async function saveAnnualReport(corporationId, patch) {
  const uid = await ownerId();
  const existing = await getAnnualReport(corporationId);
  const payload = { ...patch };
  if (existing && 'due_date' in patch && patch.due_date !== existing.due_date) {
    payload.due_notice_bucket = null;
  }
  if (existing) return one(supabase.from('annual_reports').update(payload).eq('id', existing.id).select().single());
  return one(supabase.from('annual_reports').insert({ ...payload, corporation_id: corporationId, owner_id: uid }).select().single());
}

// Mark this year's report filed: stamp today's filed date and roll the deadline
// forward one year (re-arming the reminder for next year). No-op if no due date yet.
export async function markAnnualReportFiled(corporationId, today = new Date()) {
  const existing = await getAnnualReport(corporationId);
  const todayIso = localDateIso(today);
  const nextDue = advanceDueDate(existing?.due_date) || null;
  return saveAnnualReport(corporationId, { last_filed_date: todayIso, due_date: nextDue });
}

// Batched counts for ALL corporations in two bulk queries. Returns a map
// { [corpId]: { properties, tenants } }.
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
// Columns for LIST views of leases — everything EXCEPT the big `lease_text` blob
// (a full lease can be tens of KB). Only the single-lease detail page needs the
// text, so property/tenant lists and the Overview prefetch stay light. getLease
// (below) keeps select('*') for the detail page.
const LEASE_LIST_COLS =
  'id,owner_id,property_id,tenant_name,square_footage,base_rent,lease_start,lease_termination_date,lease_terms,share_override_pct,source,extraction_status,lease_file_id,created_at,updated_at,roof_responsible,ai_confidence,tenant_email,tenant_contact_name,no_renewal_option,is_active,premises_address,est_cam_annual,est_tax_annual,est_roof_annual';

export const listLeases = async (propertyId) => {
  const all = await rows(supabase.from('leases').select(LEASE_LIST_COLS).eq('property_id', propertyId).order('tenant_name'));
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
    supabase.from('leases').select(LEASE_LIST_COLS).in('property_id', ids).order('tenant_name')
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
  // Snapshot the tenant's billing history BEFORE deleting the lease. Deleting the
  // lease row cascades to its invoices and payments (0023 ON DELETE CASCADE), so
  // without this the entire AR / payment ledger for the tenant would be lost for
  // good. Best-effort: a read hiccup must never block removing the tenant, but we
  // preserve the record whenever we can (kept in expired_leases.financials).
  let financials = null;
  try {
    const invoices = (await listInvoices(lease.id)) || [];
    const payments = (await Promise.all(invoices.map((i) => listPayments(i.id)))).flat();
    financials = { invoices, payments, archived_at: new Date().toISOString() };
  } catch (_e) { /* keep null — never block removal on a history read */ }
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
      financials,
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
  // Build the exact rows to write (owner_id is forced server-side inside the RPC).
  const leasePayload = {
    ...lease,
    property_id: propertyId,
    source: 'ai_extracted',
    extraction_status: 'reviewed',
    ai_confidence: aiConfidence ?? null,
    lease_file_id: leaseFileId,
    lease_text: leaseText ?? null,
  };
  const escPayload = (escalations || []).map((e) => ({ ...e, status: 'scheduled' }));
  // ATOMIC: insert the lease + all its escalations / renewals / abatements in ONE
  // transaction. Previously these were separate REST calls, so a failure partway
  // through left a half-built lease (e.g. no rent steps) that billed wrong and
  // couldn't be re-derived. create_lease_tx makes it all-or-nothing.
  const leaseId = await callRpc('create_lease_tx', {
    p_lease: leasePayload,
    p_escalations: escPayload,
    p_renewals: renewals || [],
    p_abatements: abatements || [],
  });
  // Collapse the historical schedule to today: set the current rent + period (or
  // flag the lease outdated), marking past escalations/renewals applied silently.
  await backfillLeaseToToday(leaseId);
  return getLease(leaseId);
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
      patch.lease_termination_date = localDateIso(d);
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
// It carries a lot of facts now (roof responsibility, lease terms, contact, this
// year's billed CAM/tax share + total, next rent step, free-rent window, additional
// insured, annual-report dates, occupancy) so the assistant can answer most
// questions from records alone — never any documents.
export async function fetchPortfolioSnapshot(features) {
  const year = Number(localDateIso().slice(0, 4)); // current calendar/fiscal year for the views
  const [corporations, properties, leases, insurance, contracts, renewals, balances, escalations, abatements, annualReports] =
    await Promise.all([
      rows(supabase.from('corporations').select('id,name,address')),
      rows(supabase.from('properties').select('id,name,address,corporation_id,building_sf')),
      rows(supabase.from('leases').select('id,tenant_name,tenant_email,tenant_contact_name,premises_address,property_id,square_footage,base_rent,lease_start,lease_termination_date,is_active,roof_responsible,lease_terms,updated_at,created_at')),
      rows(supabase.from('insurance_policies').select('id,party,property_id,lease_id,insurer,expiry_date,additional_insured,archived_at,updated_at,created_at').is('archived_at', null)),
      rows(supabase.from('service_contracts').select('id,property_id,service_type,vendor,amount,frequency,end_date,updated_at,created_at')),
      rows(supabase.from('renewal_options').select('lease_id,status')),
      rows(supabase.from('v_invoice_balances').select('lease_id,balance,display_status,due_date')),
      rows(supabase.from('rent_escalations').select('lease_id,effective_date,status,new_base_rent,updated_at,created_at')),
      rows(supabase.from('rent_abatements').select('lease_id,kind,value,start_date,end_date,updated_at,created_at')),
      rows(supabase.from('annual_reports').select('corporation_id,due_date,last_filed_date,updated_at,created_at')),
    ]);

  // Per-tenant billed CAM/tax/roof share and per-property occupancy for the current
  // year (from the two computed views). Query by the property ids we just loaded.
  const propIds = (properties || []).map((p) => p.id);
  let shares = [];
  let totals = [];
  if (propIds.length) {
    [shares, totals] = await Promise.all([
      rows(supabase.from('v_tenant_shares').select('lease_id,property_id,cam_amount,tax_amount,roof_amt,base_rent').in('property_id', propIds).eq('year', year)),
      rows(supabase.from('v_property_totals').select('property_id,occupancy,vacant_sf,total_revenue').in('property_id', propIds).eq('year', year)),
    ]);
  }

  return buildPortfolioSnapshot({
    corporations, properties, leases, insurance, contracts, renewals, balances,
    escalations, abatements, annualReports, shares, totals, features,
  });
}

// Cache read/write (best-effort — the feature still works if the table is absent).
// `questionKey` is the row key; the docs fallback prefixes it with 'docs::' so a
// records answer and a documents answer for the same question never collide.
async function getCachedPortfolioAnswer(questionKey, fingerprint) {
  try {
    const { data } = await supabase
      .from('portfolio_qa_cache')
      .select('answer_json')
      .eq('question_norm', questionKey)
      .eq('snapshot_fingerprint', fingerprint)
      .maybeSingle();
    return data?.answer_json?.answer ?? null;
  } catch {
    return null;
  }
}

async function writeCachedPortfolioAnswer(questionKey, fingerprint, answer) {
  const uid = await ownerId();
  // One row per (user, question key): drop any stale-fingerprint rows for this
  // question before inserting the fresh answer.
  await supabase.from('portfolio_qa_cache').delete().eq('user_id', uid).eq('question_norm', questionKey);
  await supabase.from('portfolio_qa_cache').insert({
    user_id: uid,
    question_norm: questionKey,
    snapshot_fingerprint: fingerprint,
    answer_json: { answer },
  });
}

// Returns { answer, fromCache, needsDocs }. Pass the snapshot from
// fetchPortfolioSnapshot. `needsDocs` is true when the facts summary didn't contain
// what the question needs — the UI then offers the "read my leases" fallback below.
export async function askPortfolioQuestion(question, snapshot) {
  const questionNorm = normalizeQuestion(question);
  if (!questionNorm) return { answer: '', fromCache: false, needsDocs: false };
  const snapshotText = snapshotToText(snapshot);

  // Demo mode: canned, data-driven answer — no network, no caching. The structured
  // snapshot rides along so the mock can answer from real seeded data.
  if (DEMO_MODE) {
    const { answer, needs_docs } = await invokeFunction('ask-portfolio', { question, snapshot: snapshotText, snapshot_obj: snapshot });
    return { answer, fromCache: false, needsDocs: !!needs_docs };
  }

  const fingerprint = snapshot?.fingerprint || snapshotFingerprint({});
  const cached = await getCachedPortfolioAnswer(questionNorm, fingerprint);
  // A cached answer never carries needs_docs (we don't persist the flag) — that's
  // fine: the ghost "read the documents instead" link is always available, and a
  // repeat of a fact-answerable question doesn't need the docs button anyway.
  if (cached) return { answer: cached, fromCache: true, needsDocs: false };

  const { answer, needs_docs } = await invokeFunction('ask-portfolio', { question, snapshot: snapshotText });
  try {
    await writeCachedPortfolioAnswer(questionNorm, fingerprint, answer);
  } catch {
    /* caching is best-effort — never fail the answer on a cache write */
  }
  return { answer, fromCache: false, needsDocs: !!needs_docs };
}

// A light fingerprint of the lease-document corpus (counts + latest change stamp of
// leases and their riders). Flips whenever a lease/rider text changes, so a cached
// docs answer built on the old corpus stops matching.
async function leaseDocsFingerprint() {
  try {
    const [leases, addendums] = await Promise.all([
      rows(supabase.from('leases').select('updated_at').eq('is_active', true)),
      rows(supabase.from('lease_addendums').select('updated_at')),
    ]);
    const maxStamp = (arr) => (arr || []).reduce((m, r) => { const s = r?.updated_at || ''; return s > m ? s : m; }, '');
    return `docs-v1|L${(leases || []).length}:${maxStamp(leases)}|A${(addendums || []).length}:${maxStamp(addendums)}`;
  } catch {
    return 'docs-v1|unknown';
  }
}

// The "read my leases" fallback: reads the cached lease DOCUMENTS (server-side,
// under RLS) with a quick model and answers grouped by tenant. Costs ~a few cents
// per fresh question (repeats on an unchanged corpus are $0, cached). Only ever
// runs on an explicit click. Returns { answer, fromCache }.
export async function askLeasesDocs(question) {
  const questionNorm = normalizeQuestion(question);
  if (!questionNorm) return { answer: '', fromCache: false };

  // Demo mode: canned grouped answer from the seeded lease texts — no network.
  if (DEMO_MODE) {
    const { answer } = await invokeFunction('ask-leases', { question });
    return { answer, fromCache: false };
  }

  const key = `docs::${questionNorm}`;
  const fingerprint = await leaseDocsFingerprint();
  const cached = await getCachedPortfolioAnswer(key, fingerprint);
  if (cached) return { answer: cached, fromCache: true };

  const { answer } = await invokeFunction('ask-leases', { question });
  try {
    await writeCachedPortfolioAnswer(key, fingerprint, answer);
  } catch {
    /* caching is best-effort */
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

// One-time AI read of a corporation's annual-report document → just the filing
// deadline. Passes the landlord's LOCAL today so a recurring rule ("by April 1")
// resolves to the next occurrence against their clock, not UTC.
export async function extractAnnualReport({ text, storagePath }) {
  const { fields } = await invokeFunction('extract-annual-report', { text, storage_path: storagePath, today: localDateIso() });
  return { fields: fields || {} };
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

// Changing the end date re-arms the contract-expiry reminder emails: clear
// end_notice_bucket so the send-reminders sweep notifies again for the new date
// (same pattern saveInsurance uses for expiry_notice_bucket).
export async function updateServiceContract(id, patch) {
  const body = { ...patch };
  if ('end_date' in patch) {
    const existing = await one(supabase.from('service_contracts').select('end_date').eq('id', id).maybeSingle());
    if (existing && patch.end_date !== existing.end_date) body.end_notice_bucket = null;
  }
  return one(supabase.from('service_contracts').update(body).eq('id', id).select().single());
}

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

  // Order matters: write the new base rent FIRST, then mark the escalation applied.
  // These are two separate non-transactional writes; if the tab dies between them,
  // this ordering leaves the escalation still 'scheduled' (so the next run re-applies
  // it harmlessly) instead of 'applied' with a stale rent that never catches up
  // (applyDueEscalations skips applied rows, so that state would be permanent).
  await updateLease(escalation.lease_id, { base_rent: newRent }); // change the actual base rent in the lease terms
  const updated = await updateEscalation(escalation.id, { status: 'applied', applied_at: new Date().toISOString() });

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
  const todayIso = localDateIso(today);
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

// Record that an insurance certificate was requested from a tenant, so the Insurance
// panel + property History keep a dated trail. The app can only log that the request
// was OPENED/sent from here — it can't confirm the mail app actually delivered it.
// Best-effort (logHistoryEvent swallows errors): never blocks opening the email.
export async function logInsuranceRequest({ propertyId, leaseId, tenantName, to, subject }) {
  return logHistoryEvent({
    property_id: propertyId,
    lease_id: leaseId,
    type: 'insurance_requested',
    description: `Insurance certificate requested${tenantName ? ` from ${tenantName}` : ''}${to ? ` → ${to}` : ''}`,
    tenant_name: tenantName || null,
    event_date: paymentIsoToday(),
    meta: { to: to || null, subject: subject || null },
  });
}

// Prior insurance requests for one lease, newest first — powers the "Last requested"
// line in the tenant Insurance panel.
export async function listInsuranceRequests(leaseId) {
  const events = await rows(
    supabase.from('history_events').select('*').eq('lease_id', leaseId).eq('type', 'insurance_requested')
  );
  const stamp = (e) => e.event_date || e.created_at || '';
  return [...events].sort((a, b) => (stamp(a) < stamp(b) ? 1 : -1));
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

export async function addCamLineItem({ property_id, year, label, amount, import_id = null }) {
  const item = await one(
    supabase
      .from('cam_line_items')
      .insert({ property_id, year, label, amount, ...(import_id ? { import_id } : {}), owner_id: await ownerId() })
      .select()
      .single()
  );
  await syncCamTotal(property_id, year);
  return item;
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

// One tenant-share row (a single lease + year), for the per-lease monthly tracker:
// carries the gross base/CAM/tax/roof figures + lease_start the term-aware schedule needs.
export async function getTenantShare(leaseId, year) {
  const list = await rows(
    supabase.from('v_tenant_shares').select('*').eq('lease_id', leaseId).eq('year', year).limit(1)
  );
  return list?.[0] || null;
}

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
const paymentIsoToday = () => localDateIso();

// The live (non-void) ANNUAL invoice for a lease + year, or null. A year-end CAM/tax
// reconciliation is its own kind='reconciliation' invoice for the same lease + year —
// it must never be mistaken for the year invoice (the tracker would divide the
// true-up by 12). Old rows predate the kind column, so a missing kind reads 'annual'.
export const isAnnualInvoice = (i) => (i.kind ?? 'annual') === 'annual';

export async function getYearInvoice(leaseId, year) {
  const list = await listInvoices(leaseId);
  return list.find((i) => Number(i.year) === Number(year) && i.status !== 'void' && isAnnualInvoice(i)) || null;
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
  try {
    return await createInvoice({
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
  } catch (e) {
    // Unique index (0055): a concurrent tab / the bulk mark-all created this year's
    // invoice between our check and this insert — use theirs instead of failing.
    if (e?.code === '23505') {
      const raced = await getYearInvoice(leaseId, year);
      if (raced) return raced;
    }
    throw e;
  }
}

// Save (or refresh) the year's invoice in receivables WITHOUT ever creating a
// duplicate: at most one live invoice exists per (lease, year) — enforced by the
// 0055 unique index. If one already exists (a prior "Save to receivables", or the
// monthly tracker auto-created it), its figures are refreshed in place instead of
// doubling the AR. Returns { invoice, updated } so the UI can say which happened.
export async function upsertYearInvoice({ lease_id, property_id, year, issue_date, due_date, base_rent_annual, cam_annual, tax_annual, roof_annual, abatement_annual, total_amount }) {
  const figures = { issue_date, due_date, base_rent_annual, cam_annual, tax_annual, roof_annual, abatement_annual, total_amount };
  const existing = await getYearInvoice(lease_id, year);
  if (existing) return { invoice: await updateInvoice(existing.id, figures), updated: true };
  try {
    const invoice = await createInvoice({ lease_id, property_id, year: Number(year), status: 'sent', ...figures });
    return { invoice, updated: false };
  } catch (e) {
    if (e?.code === '23505') {
      const raced = await getYearInvoice(lease_id, year);
      if (raced) return { invoice: await updateInvoice(raced.id, figures), updated: true };
    }
    throw e;
  }
}

// buildLeaseSchedule (the term-aware monthly schedule builder) lives in
// ./leaseSchedule so the ledger math (ledger.js) can reuse the exact same
// per-month owed shape. Imported at the top of this file.

// Everything the ledger grid needs for one lease + year in one call: the year's
// invoice (or null), the expected annual/monthly amount, which months are paid
// (period_month -> { amount, ids, paid_date, method }), and the raw payments so
// the coverage allocator can pool untagged (lump/partial) money too.
export async function getMonthlyRent(leaseId, year) {
  const [invoice, abatements, share, escalations] = await Promise.all([
    getYearInvoice(leaseId, year),
    listAbatements(leaseId),
    getTenantShare(leaseId, year),
    listEscalations(leaseId),
  ]);
  // GROSS full-year base + other charges give the schedule its SHAPE; the invoice total
  // (when one exists) is what the months settle against. The tenant-share view is the source
  // of truth for the gross figures.
  let grossBase = 0;
  let billed = { cam: 0, tax: 0, roof: 0 };
  if (share) {
    grossBase = Number(share.base_rent || 0);
    billed = billedComponents(share);
  } else if (invoice) {
    grossBase = Number(invoice.base_rent_annual || 0);
    billed = { cam: Number(invoice.cam_annual || 0), tax: Number(invoice.tax_annual || 0), roof: Number(invoice.roof_annual || 0) };
  }
  const other = billed.cam + billed.tax + billed.roof;
  const { schedule, annual, owedMonths, occupancyStartIso: occ, factor } = buildLeaseSchedule({
    year, grossBase, otherAnnual: other, abatements, escalations,
    leaseStart: share?.lease_start, invoiceTotal: invoice ? Number(invoice.total_amount || 0) : null,
  });

  const payments = invoice ? await listPayments(invoice.id) : [];
  const byMonth = {};
  for (const p of payments) {
    const m = Number(p.period_month);
    if (!m) continue; // skip untagged (annual/partial) payments
    const b = (byMonth[m] ||= { amount: 0, ids: [], paid_date: p.paid_date, method: p.method });
    b.amount += Number(p.amount) || 0;
    b.ids.push(p.id);
  }
  return { invoice, annual, monthly: owedMonths ? annual / owedMonths : 0, owedMonths, byMonth, payments, schedule, factor, occupancyStartIso: occ, hasAbatement: (abatements || []).length > 0 };
}

// Mark month (1-12) paid: ensure the year's invoice exists, then record a payment
// tagged with that month. amount defaults to the monthly share (invoice total / 12).
export async function markMonthPaid(leaseId, propertyId, year, month, opts = {}) {
  const invoice = await ensureInvoice(leaseId, propertyId, year);
  const m = Number(month);
  // Already marked — from this screen, the property ledger, or another device.
  // Recording again would double-count the month, so this is an idempotent no-op.
  const existingPayments = await listPayments(invoice.id);
  if (existingPayments.some((p) => Number(p.period_month) === m)) return invoice;
  let amount;
  if (opts.amount != null && opts.amount !== '') {
    amount = Number(opts.amount);
  } else {
    // Default to that month's expected owed from the TERM-AWARE schedule (built off the gross
    // full-year share, prorated for a mid-year start + blended for mid-year steps + net of any
    // base-rent abatement, then scaled to settle THIS invoice) — NOT a flat total/12, which
    // over-bills free months and mis-bills a partial-year lease.
    const [abatements, share, escalations] = await Promise.all([
      listAbatements(leaseId), getTenantShare(leaseId, year), listEscalations(leaseId),
    ]);
    const grossBase = share ? Number(share.base_rent || 0) : Number(invoice.base_rent_annual || 0);
    const billed = share ? billedComponents(share) : { cam: Number(invoice.cam_annual || 0), tax: Number(invoice.tax_annual || 0), roof: Number(invoice.roof_annual || 0) };
    const { schedule: sched } = buildLeaseSchedule({
      year, grossBase, otherAnnual: billed.cam + billed.tax + billed.roof, abatements, escalations,
      leaseStart: share?.lease_start, invoiceTotal: Number(invoice.total_amount || 0),
    });
    amount = sched[m]?.owed ?? (Number(invoice.total_amount || 0) / 12);
  }
  // Nothing due this month (before the tenancy began, or a fully-free base with no other
  // charges) — don't record a $0 payment; the month shows "—" or "Free". An explicit
  // amount override still records.
  if (!(amount > 0) && (opts.amount == null || opts.amount === '')) return invoice;
  await recordPayment({
    invoice_id: invoice.id,
    lease_id: leaseId,
    amount,
    paid_date: opts.paid_date || paymentIsoToday(),
    method: opts.method || 'check',
    note: opts.note || null,
    period_month: m,
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
// (for `year`). Idempotent — tenants already marked for that month, or with nothing
// owed (a fully-free abated month), are skipped. Returns { paid, skipped, total }.
//
// Fast path: one batched read (getPropertyMonthlyRoll) tells us exactly who's unpaid
// and what each owes; invoices that don't exist yet are drafted in PARALLEL; then all
// the month's payments are written in ONE insert — instead of a per-tenant serial loop.
export async function markMonthPaidAllTenants(propertyId, year, month, opts = {}) {
  const m = Number(month);
  const roll = await getPropertyMonthlyRoll(propertyId, year);
  // Owe this month (net of abatement), not already marked paid for it, and not already
  // COVERED by pooled untagged money — a tenant who paid a lump (no month tags) must not
  // be billed the month again; a partially-covered month is only topped up by its gap.
  const targets = roll
    .map((r) => {
      if (r.byMonth[m] || !((Number(r.schedule?.[m]?.owed) || 0) > 0)) return null;
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments });
      const gap = Math.round((alloc.owed[m - 1] - alloc.coverage[m - 1]) * 100) / 100;
      if (!(gap > 0.05)) return null;
      return { r, amount: gap };
    })
    .filter(Boolean);
  const skipped = roll.length - targets.length;
  if (targets.length === 0) return { paid: 0, skipped, total: roll.length };

  // Draft any missing year-invoices concurrently (the only per-tenant remote cost left).
  const withInvoice = await Promise.all(
    targets.map(async (t) => ({
      ...t,
      invoiceId: t.r.invoice_id || (await ensureInvoice(t.r.lease_id, propertyId, year)).id,
    }))
  );

  const owner = await ownerId();
  const paidDate = opts.paid_date || paymentIsoToday();
  const payRows = withInvoice.map(({ r, amount, invoiceId }) => ({
    invoice_id: invoiceId,
    lease_id: r.lease_id,
    amount,
    paid_date: paidDate,
    method: opts.method || 'check',
    note: opts.note || null,
    period_month: m,
    owner_id: owner,
  }));
  await rows(supabase.from('payments').insert(payRows));
  return { paid: payRows.length, skipped, total: roll.length };
}

// Property ledger roll: one row per tenant for `year` with their monthly amount,
// which months are paid, and the raw payments — powers the Ledger grid + "mark all
// paid". Uses the year's invoice total when an invoice exists, else an estimate from
// the tenant-share figures (exact once the first month is marked and the invoice is born).
export async function getPropertyMonthlyRoll(propertyId, year) {
  const [shares, invoices] = await Promise.all([
    getTenantShares(propertyId, year),
    listInvoicesForProperty(propertyId),
  ]);
  const leaseIds = shares.map((s) => s.lease_id);
  const [abByLease, escByLease] = await Promise.all([
    listAbatementsForLeases(leaseIds),
    listEscalationsByLeases(leaseIds),
  ]);
  const invByLease = {};
  for (const inv of invoices) {
    // Annual invoices only — a kind='reconciliation' invoice is a one-off true-up,
    // not the year's rent (it would corrupt the monthly math).
    if (Number(inv.year) === Number(year) && inv.status !== 'void' && isAnnualInvoice(inv)) invByLease[inv.lease_id] = inv;
  }
  const paymentsByInvoice = {};
  await Promise.all(
    Object.values(invByLease).map(async (inv) => { paymentsByInvoice[inv.id] = await listPayments(inv.id); })
  );
  return shares.map((s) => {
    const inv = invByLease[s.lease_id] || null;
    // GROSS full-year base + est-else-actual charges give the schedule its shape; the invoice
    // total (when one exists) is what the months settle against. Always read the gross from the
    // tenant-share row so a preview (no invoice yet) matches what the invoice will bill.
    const grossBase = Number(s.base_rent || 0);
    const billed = billedComponents(s);
    const other = billed.cam + billed.tax + billed.roof;
    const abatements = abByLease[s.lease_id] || [];
    const escalations = escByLease[s.lease_id] || [];
    const { schedule, annual, owedMonths, occupancyStartIso: occ, factor } = buildLeaseSchedule({
      year, grossBase, otherAnnual: other, abatements, escalations,
      leaseStart: s.lease_start, invoiceTotal: inv ? Number(inv.total_amount || 0) : null,
    });
    const payments = inv ? (paymentsByInvoice[inv.id] || []) : [];
    const byMonth = {};
    for (const p of payments) {
      const m = Number(p.period_month);
      if (!m) continue;
      (byMonth[m] ||= { amount: 0 }).amount += Number(p.amount) || 0;
    }
    return { lease_id: s.lease_id, invoice_id: inv ? inv.id : null, tenant_name: s.tenant_name, annual, monthly: owedMonths ? annual / owedMonths : 0, owedMonths, byMonth, payments, schedule, factor, camTaxAnnual: billed.camTax ?? (billed.cam + billed.tax), roofAnnual: billed.roof, occupancyStartIso: occ, hasAbatement: abatements.length > 0, balance: inv ? Number(inv.balance) : null, is_active: s.is_active, lease_termination_date: s.lease_termination_date, square_footage: s.square_footage };
  });
}

// ---- CAM & tax reconciliation (0060) -----------------------------------------
// Tenants pay the lease's typed ESTIMATE during the year; at year end the landlord
// reconciles it against the actual share. Tenant underpaid → the shortfall becomes
// its own kind='reconciliation' invoice (flows into AR / aging / the overdue alert
// like any bill). Tenant overpaid → a refund record, open until the landlord marks
// it refunded (paid outside the app, per George). One reconciliation per lease-year
// (unique index); the math lives in the pure lib/reconciliation.js.
export const listReconciliations = (propertyId, year) =>
  rows(supabase.from('cam_reconciliations').select('*').eq('property_id', propertyId).eq('year', year));

export async function getReconciliation(leaseId, year) {
  const list = await rows(
    supabase.from('cam_reconciliations').select('*').eq('lease_id', leaseId).eq('year', year).limit(1)
  );
  return list?.[0] || null;
}

export async function reconcileCamTax(leaseId, propertyId, year) {
  // Idempotent: already reconciled → hand back the existing record untouched.
  const existing = await getReconciliation(leaseId, year);
  if (existing) return { recon: existing, created: false };

  const shares = await getTenantShares(propertyId, year);
  const share = (shares || []).find((s) => s.lease_id === leaseId);
  if (!share) throw new Error('No financial data for this tenant/year.');

  // Settle against the tenant's current estimate — the same figure the Finances
  // "Estimated" column and live Difference show — so the reconciliation the landlord
  // confirms is exactly the one on screen.
  const fig = reconcileFigures({ share });

  // Shortfall → its own reconciliation invoice. Per-component diffs can be negative
  // individually (CAM under, tax over) and the invoice check constraints require
  // components >= 0, so the NET goes in total_amount (components stay 0); the full
  // breakdown lives on the reconciliation row + the tenant statement letter.
  let invoiceId = null;
  if (fig.direction === 'tenant_owes') {
    const inv = await createInvoice({
      lease_id: leaseId,
      property_id: propertyId,
      year: Number(year),
      kind: 'reconciliation',
      status: 'sent',
      issue_date: paymentIsoToday(),
      due_date: localDateIso(new Date(Date.now() + 30 * 86400000)),
      total_amount: fig.diff,
      notes:
        `CAM & tax reconciliation ${year} — ` +
        fig.lines.map((l) => `${l.label}: est ${money(l.est)} vs actual ${money(l.actual)}`).join('; '),
    });
    invoiceId = inv.id;
  }

  let recon;
  try {
    recon = await one(
      supabase.from('cam_reconciliations').insert({
        owner_id: await ownerId(),
        lease_id: leaseId,
        property_id: propertyId,
        year: Number(year),
        est_cam: fig.est.cam,
        est_tax: fig.est.tax,
        est_roof: fig.est.roof,
        actual_cam: fig.actual.cam,
        actual_tax: fig.actual.tax,
        actual_roof: fig.actual.roof,
        diff: fig.diff,
        direction: fig.direction,
        // 'status' is the REFUND lifecycle: only a landlord_owes stays open here.
        // A tenant_owes settles through its invoice's payments (derived in the UI);
        // 'even' has nothing to settle.
        status: fig.direction === 'even' ? 'settled' : 'open',
        invoice_id: invoiceId,
        settled_at: fig.direction === 'even' ? paymentIsoToday() : null,
      }).select().single()
    );
  } catch (e) {
    // Two tabs raced the same reconcile — the unique index kept one; use it.
    if (e?.code === '23505') {
      const raced = await getReconciliation(leaseId, year);
      if (raced) return { recon: raced, created: false };
    }
    throw e;
  }

  const label =
    fig.direction === 'tenant_owes'
      ? `tenant owes ${money(fig.diff)}`
      : fig.direction === 'landlord_owes'
        ? `refund due to tenant ${money(Math.abs(fig.diff))}`
        : 'estimate and actual came out even';
  await logHistoryEvent({
    property_id: propertyId,
    lease_id: leaseId,
    type: 'cam_reconciled',
    description: `CAM & tax reconciled for ${year} — ${label}`,
    tenant_name: share.tenant_name || null,
    event_date: paymentIsoToday(),
    meta: { year: Number(year), diff: fig.diff, direction: fig.direction, invoice_id: invoiceId },
  });

  return { recon, created: true };
}

// The landlord paid the tenant back (outside the app) — close the refund.
export async function markReconciliationRefunded(id) {
  const recon = await one(
    supabase.from('cam_reconciliations').update({ status: 'settled', settled_at: paymentIsoToday() }).eq('id', id).select().single()
  );
  await logHistoryEvent({
    property_id: recon.property_id,
    lease_id: recon.lease_id,
    type: 'cam_refunded',
    description: `CAM & tax refund of ${money(Math.abs(Number(recon.diff)))} for ${recon.year} marked paid to tenant`,
    event_date: paymentIsoToday(),
    meta: { year: recon.year, diff: recon.diff },
  });
  return recon;
}

// Un-reconcile a year: removes the reconciliation and voids its invoice, so the
// live Difference resumes and ⚖ Reconcile is available again. Void FIRST — if this
// is interrupted mid-flight, a second Undo click completes cleanly, whereas
// deleting the record first would strand a live reconciliation invoice that blocks
// re-reconciling (the kind-scoped unique index only ignores void rows).
export async function undoReconciliation(recon) {
  if (recon.invoice_id) {
    // Void, never delete: any recorded payments stay attached and the invoice is
    // recoverable under the lease page's "removed" list.
    await updateInvoice(recon.invoice_id, { status: 'void' });
  }
  // The cam_reconciliations unique index has no status scoping, so only a hard
  // delete reopens the (lease, year) slot.
  await rows(supabase.from('cam_reconciliations').delete().eq('id', recon.id));
  await logHistoryEvent({
    property_id: recon.property_id,
    lease_id: recon.lease_id,
    type: 'cam_reconcile_undone',
    description:
      `CAM & tax reconciliation for ${recon.year} undone — year reopened` +
      (recon.invoice_id ? '; its invoice was voided (recoverable under removed)' : ''),
    event_date: paymentIsoToday(),
    meta: { year: recon.year, diff: recon.diff, direction: recon.direction, invoice_id: recon.invoice_id || null },
  });
}

// Reopen a refund that was marked paid by mistake (reverses markReconciliationRefunded).
export async function undoReconciliationRefund(id) {
  const recon = await one(
    supabase.from('cam_reconciliations').update({ status: 'open', settled_at: null }).eq('id', id).select().single()
  );
  await logHistoryEvent({
    property_id: recon.property_id,
    lease_id: recon.lease_id,
    type: 'cam_refund_reopened',
    description: `CAM & tax refund of ${money(Math.abs(Number(recon.diff)))} for ${recon.year} reopened (undo)`,
    event_date: paymentIsoToday(),
    meta: { year: recon.year, diff: recon.diff },
  });
  return recon;
}

// The reconciliation statement letter for the compose modal (nothing auto-sends).
export async function draftCamReconciliationEmail(recon) {
  const lease = await getLease(recon.lease_id);
  const prop = await getProperty(recon.property_id);
  const corp = prop?.corporation_id ? await getCorporation(prop.corporation_id) : null;
  // CAM and property tax reconcile together as one combined "CAM & tax" line; roof
  // stays its own separate line (older records may store the two split — sum them).
  const lines = [
    {
      label: 'CAM & tax',
      est: (Number(recon.est_cam) || 0) + (Number(recon.est_tax) || 0),
      actual: (Number(recon.actual_cam) || 0) + (Number(recon.actual_tax) || 0),
    },
  ];
  if (Number(recon.est_roof) > 0 || Number(recon.actual_roof) > 0) {
    lines.push({ label: 'Roof', est: Number(recon.est_roof) || 0, actual: Number(recon.actual_roof) || 0 });
  }
  return buildCamReconciliationEmail({
    business: businessFromCorp(corp),
    tenant_name: lease?.tenant_name,
    contact_name: lease?.tenant_contact_name,
    tenant_email: lease?.tenant_email,
    propertyName: prop?.name,
    year: recon.year,
    lines,
    diff: Number(recon.diff) || 0,
    direction: recon.direction,
  });
}

// ---- Alerts (computed from lease key dates, portfolio-wide) -----------------
export async function fetchAlertData() {
  const [leasesR, escR, renR, propR, insR, conR, abaR, insReqR, corpR, arR] = await Promise.all([
    supabase.from('leases').select('id,tenant_name,property_id,lease_start,lease_termination_date,no_renewal_option,is_active,base_rent'),
    supabase.from('rent_escalations').select('lease_id,effective_date,status,new_base_rent'),
    supabase.from('renewal_options').select('id,lease_id,notice_by_date,status'),
    supabase.from('properties').select('id,name,corporation_id'),
    // created_at/updated_at let buildAlerts tell whether a tenant answered an insurance
    // request (a policy saved AFTER the request) for the chase-up alert.
    supabase.from('insurance_policies').select('id,party,property_id,lease_id,insurer,expiry_date,created_at,updated_at').is('archived_at', null),
    supabase.from('service_contracts').select('id,name,vendor,vendor_email,end_date,property_id'),
    // Free-rent-ending alerts: abatement windows about to close.
    supabase.from('rent_abatements').select('lease_id,start_date,end_date,kind,value'),
    // Insurance chase-up: when each tenant was last asked for a certificate.
    supabase.from('history_events').select('lease_id,event_date,created_at').eq('type', 'insurance_requested'),
    // Annual-report alerts need the corporation name for the alert title/click target.
    supabase.from('corporations').select('id,name'),
    supabase.from('annual_reports').select('corporation_id,due_date,last_filed_date'),
  ]);
  return {
    leases: leasesR.data || [],
    escalations: escR.data || [],
    renewals: renR.data || [],
    properties: propR.data || [],
    insurance: insR.data || [],
    contracts: conR.data || [],
    abatements: abaR.data || [],
    insuranceRequests: insReqR.data || [],
    corporations: corpR.data || [],
    annualReports: arR.data || [],
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

// ---- Auto sign-out preference -----------------------------------------------
// Same user_preferences row (column auto_logout_minutes, migration 0062).
// Semantics: null = the app default (30 min), 0 = off (never auto-sign-out),
// otherwise the idle minutes before sign-out. Returns null on a fresh account or
// any error, so the caller applies its default.
export async function getAutoLogoutMinutes() {
  try {
    const uid = await ownerId();
    if (!uid) return null;
    const { data } = await supabase
      .from('user_preferences')
      .select('auto_logout_minutes')
      .eq('user_id', uid)
      .maybeSingle();
    return data?.auto_logout_minutes ?? null;
  } catch {
    return null;
  }
}

// Save the idle-minutes choice (0 = off) for the current user.
export const setAutoLogoutMinutes = async (auto_logout_minutes) =>
  one(
    supabase
      .from('user_preferences')
      .upsert(
        { user_id: await ownerId(), auto_logout_minutes, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select()
      .single()
  );

// ---- Leases-page sort preference --------------------------------------------
// Same user_preferences row (column lease_sort, migration 0058). Shape:
//   { mode: 'term_end'|'base_rent'|'psf'|'total_rent'|'address'|'custom',
//     dir: 'asc'|'desc',
//     manual: { [propId]: [leaseId, …] } }  // saved drag order, per property
// Returns {} for a fresh account or on any error, so the page falls back to its
// default (term ending, ascending) until the landlord chooses otherwise.
export async function getLeaseSort() {
  try {
    const uid = await ownerId();
    if (!uid) return {};
    const { data } = await supabase
      .from('user_preferences')
      .select('lease_sort')
      .eq('user_id', uid)
      .maybeSingle();
    return data?.lease_sort || {};
  } catch {
    return {};
  }
}

// Merge a patch into the saved lease_sort (so updating the mode doesn't wipe the
// per-property manual orders, and vice-versa). Reads the current value first.
export const setLeaseSort = async (patch) => {
  const current = await getLeaseSort();
  const next = { ...current, ...patch };
  if (patch.manual) next.manual = { ...(current.manual || {}), ...patch.manual };
  return one(
    supabase
      .from('user_preferences')
      .upsert(
        { user_id: await ownerId(), lease_sort: next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select()
      .single()
  );
};

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
  const todayIso = localDateIso(today);
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

  const todayIso = localDateIso(today);
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
    // 3a) record the renewal's year-1 rent as an APPLIED escalation so the rent ledger
    // stays in sync with base_rent. Without this the ledger keeps the PRE-renewal rent;
    // once a later step supersedes this year, effective_rent() reads it stale — the exact
    // rent-roll-vs-property-card mismatch this branch used to cause. Written AFTER the
    // lease update (an interruption then leaves base_rent right and the era-aware
    // effective_rent still answers correctly). Skipped when the rent didn't change or a
    // step already sits on this boundary (leases that print every year's rent).
    if (newStart && Number(newRent) !== Number(oldRent)) {
      const existing = await listEscalations(lease.id);
      const daysApart = (a, b) => Math.round(Math.abs(new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
      const already = existing.some((e) => e.effective_date && daysApart(String(e.effective_date), String(newStart)) <= 45);
      if (!already) {
        await rows(supabase.from('rent_escalations').insert({
          lease_id: lease.id,
          owner_id: uid,
          effective_date: newStart,
          escalation_type: 'manual',
          escalation_value: null,
          new_base_rent: newRent,
          status: 'applied',
        }));
      }
    }
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

  // Guard: a renewal rolls the new term forward from the committed term END. With no
  // end date on file, addMonths(null) would null the lease's dates and wipe today's
  // rent. Refuse and ask the landlord to set the term-end date first (mirrors the
  // { needsRent } sentinel the UI already understands).
  if (!lease.lease_termination_date) return { needsTermEnd: true, renewalId: ren.id };

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
  const wrap = (email, kind) => ({ kind, lease_id: lease.id, property_id: lease.property_id, tenant_name: lease.tenant_name, email_to: lease.tenant_email || '', email_to_2: lease.tenant_email_2 || '', email_from: business?.contact_email || '', email_subject: email.subject, email_body: email.body });

  if (focus === 'termination') return wrap(buildNonRenewalEmail({ ...common, leaseEnd: lease.lease_termination_date }), 'lease_ending');
  // A tenant insurance-expiry alert or a chase-up → the expiry-aware "please send the
  // renewed certificate" letter, naming the insurer + expiry the alert carries. (The
  // landlord's own building-policy alert has no lease_id, so it returned null above.)
  if (focus === 'insurance' || focus === 'insurance_chase') {
    return wrap(buildInsuranceRenewalRequestEmail({ ...common, insurer: alert.insurer, expiryDate: alert.expiry_date, expired: alert.expired }), 'insurance_request');
  }
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

  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateIso(d); };
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

  const todayIso = localDateIso(today);
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
  // LEASE_LIST_COLS, not '*': this runs on the first load of every day across ALL
  // leases — select('*') dragged every lease's multi-KB lease_text blob down with it.
  const leases = await rows(supabase.from('leases').select(LEASE_LIST_COLS));
  const created = [];

  const todayIso = localDateIso(today);
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
    // A partial unique index (migration 0050) guarantees at most one open
    // renewal_decision per lease. If a concurrent tab or the nightly cron created
    // it between our check above and this insert, the DB rejects it (23505) — treat
    // that as "already prompted" rather than surfacing an error.
    try {
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
    } catch (e) {
      if (e?.code !== '23505') throw e; // ignore the duplicate-prompt race; re-raise anything else
    }
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

// Permanently clear this property's activity timeline (history_events).
export const clearPropertyHistory = (propertyId) =>
  rows(supabase.from('history_events').delete().eq('property_id', propertyId));

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

// ---- Bank-statement import (0063) ------------------------------------------
// The CSV lane is parsed client-side ($0, statementParse.js); a PDF statement goes
// through the extract-bank-statement edge fn (transcribe-only). Both lanes feed the
// pure matcher (statementMatch.js) whose suggestions the review screen confirms;
// only applyStatementImport ever writes. Money math never runs in a model.

export const listImportRules = () =>
  rows(supabase.from('import_rules').select('*').order('created_at'));

// Save the "always match {pattern} → …" memory. The (owner, property, pattern)
// unique index makes re-saving a pattern update the existing rule instead of
// stacking duplicates.
export async function saveImportRule({ property_id, pattern, target_kind, lease_id = null, cam_label = null }) {
  const clean = String(pattern || '').trim();
  if (clean.length < 3) throw new Error('A rule pattern needs at least 3 characters.');
  try {
    return await one(
      supabase.from('import_rules')
        .insert({ property_id, pattern: clean, target_kind, lease_id, cam_label, owner_id: await ownerId() })
        .select().single()
    );
  } catch (e) {
    if (e?.code === '23505') {
      const existing = (await listImportRules()).find(
        (r) => r.property_id === property_id && r.pattern.toLowerCase() === clean.toLowerCase()
      );
      if (existing) {
        return one(
          supabase.from('import_rules')
            .update({ target_kind, lease_id, cam_label })
            .eq('id', existing.id).select().single()
        );
      }
    }
    throw e;
  }
}

export const deleteImportRule = (id) => rows(supabase.from('import_rules').delete().eq('id', id));

// The import register, newest first (sorted here — portable across live + mock).
export async function listStatementImports(propertyId) {
  const list = await rows(supabase.from('statement_imports').select('*').eq('property_id', propertyId));
  return [...(list || [])].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// Everything the matcher needs, assembled once per import: every property's
// tenants with their year schedule + coverage (so deposits cross-match the WHOLE
// portfolio), open reconciliation balances, the saved rules, the live import-hash
// set (the duplicate guard), and the account→property memory.
export async function getStatementMatchContext(propertyId, year) {
  const [properties, rules, allImports, hashRows, reconRows] = await Promise.all([
    rows(supabase.from('properties').select('id,name')),
    listImportRules(),
    rows(supabase.from('statement_imports').select('*')),
    rows(supabase.from('payments').select('import_hash').not('import_hash')),
    rows(supabase.from('v_invoice_balances').select('*').eq('kind', 'reconciliation')),
  ]);
  const nameOf = Object.fromEntries((properties || []).map((p) => [p.id, p.name]));

  const rolls = await Promise.all(
    (properties || []).map(async (p) => ({ p, roll: await getPropertyMonthlyRoll(p.id, year) }))
  );
  const openReconByLease = {};
  for (const inv of reconRows || []) {
    if (inv.status !== 'void' && Number(inv.balance) > 0.05) {
      openReconByLease[inv.lease_id] = { id: inv.id, balance: Number(inv.balance), year: Number(inv.year) };
    }
  }
  const tenants = [];
  for (const { p, roll } of rolls) {
    for (const r of roll) {
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments });
      const recon = openReconByLease[r.lease_id] || null;
      tenants.push({
        lease_id: r.lease_id,
        property_id: p.id,
        property_name: p.name,
        tenant_name: r.tenant_name,
        monthly: r.monthly,
        owed: alloc.owed,
        coverage: alloc.coverage,
        invoiceTotal: r.annual,
        invoiceBalance: r.balance != null ? Number(r.balance) : null,
        reconInvoiceId: recon?.id || null,
        reconBalance: recon?.balance || 0,
      });
    }
  }

  // The duplicate guard: LIVE payment hashes (a hand-deleted payment's line becomes
  // importable again automatically) + expense hashes from the imports' applied records.
  const existingHashes = new Set((hashRows || []).map((h) => h.import_hash).filter(Boolean));
  for (const imp of allImports || []) {
    for (const a of imp.applied || []) {
      if (a.kind !== 'payment' && a.hash) existingHashes.add(a.hash);
    }
  }

  // "Account ••4821 — last imported into {property}".
  let accountMemory = {};
  for (const imp of [...(allImports || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) {
    if (imp.account_hint) accountMemory[imp.account_hint] = { property_id: imp.property_id, property_name: nameOf[imp.property_id] || null };
  }

  return { properties: properties || [], tenants, rules: rules || [], existingHashes, accountMemory };
}

// Write everything the user confirmed on the review screen — exactly once, and
// record every write in `applied` so undo can reverse precisely the import's
// delta. Entries (already resolved by the review UI):
//   { type:'payment', lease_id, property_id, year, amount, date, description,
//     period_month|null, reconInvoiceId|null, hash }
//   { type:'cam', property_id, year, amount, label, hash }
//   { type:'tax'|'roof', property_id, year, amount, hash }
// The duplicate hash guard is advisory and lives in MATCHING — apply never
// re-runs it, so an "import anyway" override writes like any other row.
export async function applyStatementImport({ propertyId, year, fileName, accountHint = null, entries = [] }) {
  const imp = await one(
    supabase.from('statement_imports')
      .insert({ property_id: propertyId, year: Number(year) || null, file_name: fileName || null, account_hint: accountHint, applied: [], owner_id: await ownerId() })
      .select().single()
  );
  const applied = [];
  let paymentsCount = 0, paymentsTotal = 0, expensesCount = 0, expensesTotal = 0;
  const crossProperty = {};

  for (const e of entries) {
    if (e.type === 'payment') {
      let invoiceId = e.reconInvoiceId;
      if (!invoiceId) invoiceId = (await ensureInvoice(e.lease_id, e.property_id, e.year)).id;
      const pay = await recordPayment({
        invoice_id: invoiceId,
        lease_id: e.lease_id,
        amount: Number(e.amount),
        paid_date: e.date,
        method: 'other',
        note: e.description ? String(e.description).slice(0, 200) : null,
        period_month: e.period_month || null,
        import_id: imp.id,
        import_hash: e.hash,
      });
      applied.push({ kind: 'payment', payment_id: pay.id, invoice_id: invoiceId, lease_id: e.lease_id, property_id: e.property_id, year: e.year, amount: Number(e.amount), hash: e.hash });
      paymentsCount++; paymentsTotal += Number(e.amount);
      if (e.property_id !== propertyId) {
        crossProperty[e.property_id] = (crossProperty[e.property_id] || 0) + 1;
      }
    } else if (e.type === 'cam') {
      const item = await addCamLineItem({ property_id: e.property_id, year: e.year, label: e.label || 'Imported expense', amount: Number(e.amount), import_id: imp.id });
      applied.push({ kind: 'cam', item_id: item.id, property_id: e.property_id, year: e.year, amount: Number(e.amount), label: e.label || 'Imported expense', hash: e.hash });
      expensesCount++; expensesTotal += Number(e.amount);
    } else if (e.type === 'tax' || e.type === 'roof') {
      const cur = await getExpenseRecord(e.property_id, e.year);
      const field = e.type === 'tax' ? 'taxes_total' : 'roof_total';
      const prev = Number(cur?.[field]) || 0;
      await upsertExpenseRecord({
        property_id: e.property_id,
        year: e.year,
        taxes_total: e.type === 'tax' ? prev + Number(e.amount) : (Number(cur?.taxes_total) || 0),
        cam_total: Number(cur?.cam_total) || 0,
        roof_total: e.type === 'roof' ? prev + Number(e.amount) : (Number(cur?.roof_total) || 0),
      });
      applied.push({ kind: e.type, property_id: e.property_id, year: e.year, amount: Number(e.amount), hash: e.hash });
      expensesCount++; expensesTotal += Number(e.amount);
    }
  }

  const updated = await one(
    supabase.from('statement_imports').update({ applied }).eq('id', imp.id).select().single()
  );
  await logHistoryEvent({
    property_id: propertyId,
    type: 'statement_imported',
    description: `Imported ${fileName || 'a bank statement'} — ${paymentsCount} payment${paymentsCount === 1 ? '' : 's'} ($${paymentsTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} in) · ${expensesCount} expense${expensesCount === 1 ? '' : 's'} ($${expensesTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} out)`,
  });
  return {
    import: updated,
    summary: { paymentsCount, paymentsTotal, expensesCount, expensesTotal, crossProperty },
  };
}

// Reverse exactly what an import wrote — its delta, never George's later edits:
// payments delete by id (delete-if-exists — a hand-deleted line doesn't break it),
// CAM items delete + re-sync, taxes/roof decrement by the recorded amount CLAMPED
// at ≥ 0 (a manual edit UP survives; an edit DOWN below the imported delta clamps
// instead of going negative). The import row goes last, taking its hashes out of
// the dedupe universe so a fully-undone statement is cleanly re-importable.
export async function undoStatementImport(imp) {
  const notes = [];
  for (const a of imp.applied || []) {
    if (a.kind === 'payment') {
      await deletePayment(a.payment_id);
    } else if (a.kind === 'cam') {
      await deleteCamLineItem(a.item_id, a.property_id, a.year);
    } else if (a.kind === 'tax' || a.kind === 'roof') {
      const cur = await getExpenseRecord(a.property_id, a.year);
      const field = a.kind === 'tax' ? 'taxes_total' : 'roof_total';
      const current = Number(cur?.[field]) || 0;
      const next = Math.max(0, Math.round((current - Number(a.amount)) * 100) / 100);
      if (current - Number(a.amount) < -0.005) notes.push(`${a.kind === 'tax' ? 'Taxes' : 'Roof'} FY${a.year} was below the imported amount — clamped at $0.`);
      await upsertExpenseRecord({
        property_id: a.property_id,
        year: a.year,
        taxes_total: a.kind === 'tax' ? next : (Number(cur?.taxes_total) || 0),
        cam_total: Number(cur?.cam_total) || 0,
        roof_total: a.kind === 'roof' ? next : (Number(cur?.roof_total) || 0),
      });
    }
  }
  await rows(supabase.from('statement_imports').delete().eq('id', imp.id));
  await logHistoryEvent({
    property_id: imp.property_id,
    type: 'statement_import_undone',
    description: `Undid the import of ${imp.file_name || 'a bank statement'} — its payments and expense additions were reversed.`,
  });
  return { notes };
}

// The PDF lane: one Haiku transcription read (~5–15¢) that ONLY transcribes lines
// verbatim; every returned row still passes normalizeStatementRows before matching.
export async function extractBankStatement({ path }) {
  return invokeFunction('extract-bank-statement', { path });
}
