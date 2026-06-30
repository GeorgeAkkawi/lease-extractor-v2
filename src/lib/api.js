// Central data access. Every function is owner-scoped automatically by RLS.
// Pages call these via @tanstack/react-query; shared query keys mean a Page 1
// edit invalidates and refreshes Page 2.
import { supabase, invokeFunction } from './supabaseClient';
import { money, fmtDate } from './format';
import { addMonths, monthsBetween } from './renewals';
import { buildRenewalEmail, buildEscalationEmail } from './emailTemplates';
import { priorRentBefore, computeEscalatedRent } from './escalations';
import { resolveCurrentTerm } from './leaseTerm';

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
export const listLeases = (propertyId) =>
  rows(supabase.from('leases').select('*').eq('property_id', propertyId).order('tenant_name'));

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
export async function createLeaseFromExtraction({ propertyId, leaseFileId, lease, escalations, renewals, aiConfidence, leaseText }) {
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
  // Collapse the historical schedule to today: set the current rent + period (or
  // flag the lease outdated), marking past escalations/renewals applied silently.
  await backfillLeaseToToday(row.id);
  return getLease(row.id);
}

// Shape AI-extracted escalation rows into rent_escalations inserts, computing the
// new_base_rent for each step from the prior rent (shared by lease intake +
// addendum import). Sorted by date so the % / $ steps compound correctly.
export function buildEscalations(baseRent, escalations) {
  if (!escalations?.length) return [];
  const sorted = [...escalations].filter((e) => e.effective_date).sort((a, b) => new Date(a.effective_date) - new Date(b.effective_date));
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

// Shape AI-extracted renewal options into renewal_options inserts.
export function buildRenewals(renewals) {
  if (!renewals?.length) return [];
  return renewals.map((r) => ({
    option_label: r.option_label ?? null,
    notice_by_date: r.notice_by_date ?? null,
    term_months: r.term_months ?? null,
    new_rent: r.new_rent ?? null,
    annual_escalation_pct: r.annual_escalation_pct ?? null,
    notes: r.notes ?? null,
  }));
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
export const getPropertyInsurance = (propertyId) =>
  one(supabase.from('insurance_policies').select('*').eq('property_id', propertyId).eq('party', 'landlord').maybeSingle());

export const getTenantInsurance = (leaseId) =>
  one(supabase.from('insurance_policies').select('*').eq('lease_id', leaseId).eq('party', 'tenant').maybeSingle());

// Insert-or-update the single policy row for this scope (one landlord policy per
// property, one tenant policy per lease).
export async function saveInsurance({ party, propertyId, leaseId, ...fields }) {
  const uid = await ownerId();
  const existing = party === 'landlord' ? await getPropertyInsurance(propertyId) : await getTenantInsurance(leaseId);
  const payload = { party, property_id: propertyId ?? null, lease_id: leaseId ?? null, ...fields };
  if (existing) return one(supabase.from('insurance_policies').update(payload).eq('id', existing.id).select().single());
  return one(supabase.from('insurance_policies').insert({ ...payload, owner_id: uid }).select().single());
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
  for (const e of due) {
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
    if (lease.is_active !== false) await updateLease(leaseId, { is_active: false });
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
  return res;
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
export async function extractAddendum({ text, storagePath }) {
  const { fields, full_text } = await invokeFunction('extract-addendum', { text, storage_path: storagePath });
  return { fields: fields || {}, addendum_text: full_text || text || null };
}

// Apply an addendum's changes to the lease, then re-resolve the current period.
// `changes` carries normalized values: { extensionEnd, newRent, escalations[], renewals[] }.
// Escalation/renewal rows are stamped with addendum_id for provenance. An
// "extension" is modeled as a renewal option chained from the current term end so
// the same renewal engine handles it. Returns the resolver result.
export async function applyAddendum(addendum, changes = {}) {
  const uid = await ownerId();
  const leaseId = addendum.lease_id;
  const lease = await getLease(leaseId);

  // Escalations contributed by the rider.
  const escRows = buildEscalations(lease?.base_rent, changes.escalations);
  if (escRows.length) {
    await rows(
      supabase.from('rent_escalations').insert(
        escRows.map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled', addendum_id: addendum.id }))
      )
    );
  }

  // Renewal options contributed by the rider.
  const renRows = buildRenewals(changes.renewals);

  // An extension → a renewal option from the current term end to the new end.
  if (changes.extensionEnd) {
    const fromEnd = lease?.lease_termination_date || addendum.amendment_date || null;
    renRows.push({
      option_label: addendum.label || 'Extension',
      notice_by_date: null,
      term_months: fromEnd ? monthsBetween(fromEnd, changes.extensionEnd) : null,
      new_rent: changes.newRent != null ? Number(changes.newRent) : null,
      notes: addendum.summary || null,
    });
  }

  if (renRows.length) {
    await rows(
      supabase.from('renewal_options').insert(
        renRows.map((r) => ({ ...r, lease_id: leaseId, owner_id: uid, status: 'pending', addendum_id: addendum.id }))
      )
    );
  }

  return backfillLeaseToToday(leaseId);
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
  const [leasesR, escR, renR, propR, insR] = await Promise.all([
    supabase.from('leases').select('id,tenant_name,property_id,lease_termination_date,no_renewal_option,is_active'),
    supabase.from('rent_escalations').select('lease_id,effective_date,status'),
    supabase.from('renewal_options').select('lease_id,notice_by_date,status'),
    supabase.from('properties').select('id,name,corporation_id'),
    supabase.from('insurance_policies').select('party,property_id,lease_id,insurer,expiry_date'),
  ]);
  return {
    leases: leasesR.data || [],
    escalations: escR.data || [],
    renewals: renR.data || [],
    properties: propR.data || [],
    insurance: insR.data || [],
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

// ---- Notifications ----------------------------------------------------------
export const listNotifications = () =>
  rows(supabase.from('notifications').select('*').order('created_at', { ascending: false }));

export const markNotificationRead = (id) =>
  one(supabase.from('notifications').update({ read: true }).eq('id', id).select().single());

// Dismiss (clear) a notification entirely.
export const dismissNotification = (id) =>
  rows(supabase.from('notifications').delete().eq('id', id));

// ---- Automatic lease renewals ----------------------------------------------
// When a lease's term has ended and a still-pending renewal option exists, roll
// the lease into its new term automatically: archive the prior term, extend the
// dates, apply the new rent, mark the option applied, and drop a notification
// (with a ready-to-send tenant email) telling the user it happened.
// All math is code; only this runs on app load in demo. At go-live the same
// logic runs as a scheduled job (see migration 0007).
export async function applyDueRenewals(today = new Date()) {
  const uid = await ownerId();
  const todayIso = today.toISOString().slice(0, 10);
  const leases = await rows(supabase.from('leases').select('*'));
  const corpCache = new Map();
  const created = [];

  for (const l of leases) {
    if (l.is_active === false) continue; // outdated leases stay parked until an extension is added

    // Catch up through EVERY due option in one pass (a lease unopened for several
    // option periods rolls all the way to today), instead of one per app-load.
    let lease = l;
    let guard = 0;
    while (lease.lease_termination_date && lease.lease_termination_date <= todayIso && guard < 60) {
      guard += 1;
      const pending = await rows(
        supabase.from('renewal_options').select('*').eq('lease_id', lease.id).eq('status', 'pending').order('notice_by_date')
      );
      const ren = pending[0];
      if (!ren) break;

      const newStart = lease.lease_termination_date;             // new term begins as the old one ends
      const newEnd = addMonths(lease.lease_termination_date, ren.term_months || 12);
      const oldRent = Number(lease.base_rent) || 0;
      // First renewal-year rent: explicit new_rent wins; else apply the annual % to the
      // prior rent; else carry the prior rent.
      const pct = Number(ren.annual_escalation_pct) || 0;
      const newRent = ren.new_rent != null ? Number(ren.new_rent) : (pct > 0 ? round2(oldRent * (1 + pct / 100)) : oldRent);
      const prop = await getProperty(lease.property_id);
      if (prop?.corporation_id && !corpCache.has(prop.corporation_id)) {
        corpCache.set(prop.corporation_id, await getCorporation(prop.corporation_id));
      }
      const business = businessFromCorp(prop?.corporation_id ? corpCache.get(prop.corporation_id) : null);

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
          note: `Auto-renewed (${ren.option_label || 'renewal option'}) — new term through ${fmtDate(newEnd)}`,
          lease_text: lease.lease_text ?? null,
        })
      );

      // 2) roll the live lease into the new term + rent
      await updateLease(lease.id, { lease_start: newStart, lease_termination_date: newEnd, base_rent: newRent });

      // 3) mark the option applied so it never re-runs
      await updateRenewal(ren.id, { status: 'applied', applied_at: new Date().toISOString() });

      // 3b) materialize the option's annual step-ups (years 2..N) as scheduled
      // escalations so a "+pct%/yr" option becomes real, dated rent steps that
      // auto-apply on their anniversaries (year 1 is the new base rent above).
      if (pct > 0) {
        const years = Math.round((ren.term_months || 12) / 12);
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

      // 4) notify ONLY for a recently-ended term — skip ancient catch-up rolls so
      //    a back-dated lease doesn't flood the inbox with historical renewals.
      if (isRecentDate(newStart, today)) {
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
              email_from: business?.contact_email || null,
              email_subject: email.subject,
              email_body: email.body,
              read: false,
            })
            .select()
            .single()
        );
        created.push(notif);
      }

      lease = await getLease(lease.id); // refresh for the next catch-up iteration
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
