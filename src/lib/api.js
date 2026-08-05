// Central data access. Every function is owner-scoped automatically by RLS.
// Pages call these via @tanstack/react-query; shared query keys mean a Page 1
// edit invalidates and refreshes Page 2.
import { supabase, invokeFunction, DEMO_MODE } from './supabaseClient';
import { money, fmtDate } from './format';
import { addMonths, optionLapsed, renewalFirstYearRent, optionScheduleSteps } from './renewals';
import { buildRenewalEmail, buildEscalationEmail, buildRenewalApproachingEmail, buildNonRenewalEmail, buildInsuranceRequestEmail, buildInsuranceRenewalRequestEmail, buildInsuranceSecondRequestEmail, buildContractRenewalEmail, buildContractNonRenewalEmail, buildVendorAdditionalInsuredEmail, buildCamReconciliationEmail, buildAiDraftEmail } from './emailTemplates';
import { reconcileFigures, billedComponents, monthlyEstimates } from './reconciliation';
import { buildLeaseSchedule, owedByMonthForInvoice } from './leaseSchedule';
import {
  allocatePayments, ledgerRowSummary, componentizeSchedule, escalationStepMonths,
  unloggedMonths, missingOnImportedMonths,
} from './ledger';
import { priorRentBefore, computeEscalatedRent, monthlyBases } from './escalations';
import { resolveCurrentTerm, cmpRenewal } from './leaseTerm';
import { abatementEnd, leadingFreeMonths } from './abatement';
import { newLeaseTargets, buildAiConfidence, leaseCamTaxAnnual } from './newLeaseTerms';
import { contractCoversYear, contractAnnualCost, stepsByContract } from './contracts';
import { contractTargets, buildContractFeeSteps, buildContractConfidence, noticeDueDate } from './contractTerms';
import { byTermEnd } from './leaseSearch';
import { buildPortfolioSnapshot, snapshotToText, snapshotFingerprint, normalizeQuestion } from './portfolio';
import { advanceDueDate } from './annualReports';
import { isValidCategory, bucketKey, defaultCategoryFor, isCapitalProne } from './expenseCategories';
import { lineCompleteness } from './dispositions';
import { amortizationFor, canAmortize, assetKindInfo } from './depreciation';
import { adjustmentAllowed, adjustmentKindInfo, monthlyAdjustments, monthName } from './adjustments';
import { isoDateOrNull } from './isoDate';

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
// CSV is here for the bank-statement lane. It was missing from BOTH this list and
// the bucket's allowed_mime_types, so validateUploadFile threw on every .csv and
// ImportStatementButton's `.catch(() => null)` swallowed it — the file was never
// kept, despite a comment saying it was (fixed with the bucket, migration 0070).
// Browsers report a .csv variously as text/csv, application/csv, or (on machines
// with Excel installed) application/vnd.ms-excel, so all three are accepted; the
// extension check below is what actually constrains it.
const ALLOWED_UPLOAD_TYPES = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', DOCX_TYPE,
  'text/csv', 'application/csv', 'application/vnd.ms-excel',
]);
const ALLOWED_UPLOAD_EXTS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'docx', 'csv']);

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

// ---------------------------------------------------------------------------
// Announcements — one notice to every tenant of a property
// ---------------------------------------------------------------------------

// Draft a building-wide notice from a plain-English request. NOTE what is NOT sent:
// no lease rows, no tenant names, no figures — only the property and a head count. That
// is the structural guarantee behind "an announcement mentions no individual tenant";
// the model cannot name someone it was never told about. ~1–2¢, click-gated.
export function draftAnnouncement({ request, property, businessName }) {
  return invokeFunction('draft-announcement', {
    request,
    property: {
      name: property?.name || '',
      address: property?.address || '',
      tenant_count: property?.tenant_count ?? null,
    },
    business_name: businessName || '',
  });
}

// Send one announcement to many tenants in a single call. Deliberately NOT a client-side
// loop over sendTenantEmail: that function is capped at 10 sends/minute, so a building
// with eleven tenants would deliver to some and not others. Returns
// { sent: [{to,id}], failed: [{to,error}] } so a partial delivery is reported honestly.
// Landlord-initiated only — never auto-sends.
export function sendAnnouncement({ recipients, subject, body, replyTo }) {
  return invokeFunction('send-announcement', {
    recipients: (recipients || []).map((to) => ({ to })),
    subject,
    body,
    reply_to: replyTo || null,
  });
}

// Saved announcement templates, newest-used first (matches the table's index).
export const listAnnouncementTemplates = () =>
  rows(supabase.from('announcement_templates').select('*').order('last_used_at', { ascending: false, nullsFirst: false }));

// `body` and `subject` arrive already tokenized by src/lib/announcementTokens.js — the
// row stores {date}/{property}/{business}, never a rendered letter.
export async function saveAnnouncementTemplate({ name, subject, body, aiRequest }) {
  return one(
    supabase.from('announcement_templates')
      .insert({
        name: String(name || '').trim().slice(0, 120) || 'Untitled announcement',
        subject: subject || '',
        body: body || '',
        ai_request: aiRequest || null,
        owner_id: await ownerId(),
      })
      .select().single()
  );
}

export const deleteAnnouncementTemplate = (id) =>
  rows(supabase.from('announcement_templates').delete().eq('id', id));

// Stamped when a template is loaded, so the list stays ordered by what he actually reuses.
export const touchAnnouncementTemplate = (id) =>
  rows(supabase.from('announcement_templates').update({ last_used_at: new Date().toISOString() }).eq('id', id));

// Record that a notice went out, so the property History keeps a dated trail. One row per
// announcement, not per recipient — it is a building-level event with no lease_id, which
// is also why it is deliberately absent from the tenantStory allowlist (src/lib/tenantStory.js):
// a building notice shouldn't clutter each individual tenant's story.
// Best-effort (logHistoryEvent swallows errors): never blocks or undoes a send.
// `sentCount` is TENANTS reached, `emailsSent` is messages actually delivered — they differ
// whenever two tenancies share a contact address (one landlord, two businesses, one inbox).
// The description leads with tenants because that is what the landlord ticked.
export async function logAnnouncementSent({ propertyId, propertyName, subject, sentCount, emailsSent = sentCount, failedCount = 0 }) {
  return logHistoryEvent({
    property_id: propertyId,
    lease_id: null,
    type: 'announcement_sent',
    description:
      `Announcement sent to ${sentCount} tenant${sentCount === 1 ? '' : 's'}` +
      `${emailsSent !== sentCount ? ` (${emailsSent} email${emailsSent === 1 ? '' : 's'} — shared addresses)` : ''}` +
      `${propertyName ? ` at ${propertyName}` : ''}${failedCount ? ` · ${failedCount} failed` : ''}` +
      `${subject ? ` — ${subject}` : ''}`,
    event_date: paymentIsoToday(),
    meta: { subject: subject || null, sent: sentCount, emails: emailsSent, failed: failedCount },
  });
}

// ---------------------------------------------------------------------------
// E-signature — a document sent out, signed, and countersigned
// ---------------------------------------------------------------------------

// Every envelope on one lease, newest first, each carrying its tenant signer's name so a
// row can say "Waiting on City Dental" without a second round trip.
//
// TWO QUERIES, NOT A NESTED SELECT, on purpose: postgrest's embedded-resource syntax
// (`select('*, envelope_signers(...)')`) is not implemented by the demo mock, so a nested
// select would pass every test and return undefined signers live. Stitching in JS is the
// same cost and works identically in both. (Same class of trap as the `not()` incident —
// see the comment at mockClient.js:155.)
export async function listEnvelopes(leaseId) {
  return envelopesWhere('lease_id', leaseId);
}

// The contracts-tab twin (0093). Same stitch, different anchor column — an envelope belongs
// to a lease OR to a service contract, and exactly one of the two is set.
//
// ⚠ The signer row it reads is still role='tenant': 0085's constraint allows exactly
// ('tenant','landlord'), and the role names the SIDE that holds the signing link, not the
// kind of person. src/lib/envelopes.js `counterparty()` is what turns it into "vendor" on
// screen — one function, so no surface can get it wrong on its own.
export async function listContractEnvelopes(contractId) {
  return envelopesWhere('contract_id', contractId);
}

async function envelopesWhere(column, value) {
  if (!value) return [];
  const envs = await rows(
    supabase.from('signature_envelopes').select('*').eq(column, value).order('sent_at', { ascending: false })
  );
  if (!envs?.length) return [];
  const signers = await rows(
    supabase.from('envelope_signers').select('*').in('envelope_id', envs.map((e) => e.id))
  );
  const tenantOf = {};
  (signers || []).forEach((s) => { if (s.role === 'tenant') tenantOf[s.envelope_id] = s; });
  return envs.map((e) => ({
    ...e,
    signer_name: tenantOf[e.id]?.name || null,
    signer_email: tenantOf[e.id]?.email || null,
    signer_typed_name: tenantOf[e.id]?.typed_name || null,
  }));
}

// The audit trail for one envelope — the same rows the certificate page is printed from,
// so the landlord can read them without opening the PDF.
export const listEnvelopeEvents = (envelopeId) =>
  rows(supabase.from('envelope_events').select('*').eq('envelope_id', envelopeId).order('at'));

// Send a document out for signature. The document must already be uploaded (uploadDoc) —
// the edge function downloads those exact bytes and hashes them itself, because a
// client-supplied hash would be a seal chosen by the sealer.
//
// Returns { envelope_id, sign_url, emailed }. `sign_url` carries the raw token and is the
// ONLY time it is ever visible: nothing stores it, and no endpoint can recover it. Show it
// as a copyable fallback, never persist it.
export function sendForSignature({
  leaseId, contractId, propertyId, renewalOptionId, purpose, title, storagePath, filename,
  message, signerName, signerEmail, expiresAt, replyTo, landlordName,
}) {
  return invokeFunction('send-for-signature', {
    // 0093 — a lease document or a service contract, never both. The edge function refuses
    // the pair and ck_env_one_owner refuses it again; nulling the unused one here is what
    // keeps a `contract_id: undefined` from reaching the mock as "not equal to null".
    lease_id: leaseId || null,
    contract_id: contractId || null,
    property_id: propertyId,
    renewal_option_id: renewalOptionId || null,
    purpose: purpose || 'other',
    title,
    storage_path: storagePath,
    filename: filename || null,
    message: message || null,
    signer_name: signerName || null,
    signer_email: signerEmail,
    expires_at: expiresAt,
    reply_to: replyTo || null,
    landlord_name: landlordName || null,
  });
}

// Send it again — mints a NEW token and retires the old one, so the previous link stops
// working immediately. Also the fix for an expired link, which is why the button offers it
// on both 'sent' and 'expired' (see canResend, src/lib/envelopes.js).
export function resendEnvelope({ envelopeId, expiresAt, replyTo, signerEmail, signerName }) {
  return invokeFunction('send-for-signature', {
    resend_envelope_id: envelopeId,
    expires_at: expiresAt,
    reply_to: replyTo || null,
    signer_email: signerEmail,
    signer_name: signerName || null,
  });
}

// The landlord's signature, which executes the document: builds the signed PDF with both
// signatures and the certificate of completion, files it, and emails a copy to both parties.
// Applies NOTHING to the lease — see the header of countersign-envelope/index.ts.
export function countersignEnvelope({ envelopeId, typedName, signaturePng, placement }) {
  return invokeFunction('countersign-envelope', {
    envelope_id: envelopeId, typed_name: typedName, signature_png: signaturePng,
    // { page, x, y, w } in PDF points, or null — null falls back to an appended signature
    // page rather than refusing to complete the document.
    placement: placement || null,
  });
}

// Every signer on one envelope, including where each placed their mark. Read by the
// countersign screen so the landlord sees the tenant's signature sitting where they actually
// put it, before he commits his own.
export const listEnvelopeSigners = (envelopeId) =>
  rows(supabase.from('envelope_signers').select('*').eq('envelope_id', envelopeId));

// Remove an envelope entirely — the row, its signers, its events and its files.
//
// ⚠ THIS IS THE ONE DESTRUCTIVE OPERATION IN THE E-SIGNATURE FEATURE. On an executed
// envelope it destroys a signed legal document and its audit trail. It exists because a test
// run has to be removable and a landlord's own records are his to delete; the caller is
// responsible for a confirm that names exactly what is lost (see deleteSeverity in
// src/lib/envelopes.js). Signers and events go by ON DELETE CASCADE (0085); the files have to
// be swept explicitly because storage has no foreign keys.
export async function deleteEnvelope(envelopeId) {
  const signers = await listEnvelopeSigners(envelopeId);
  const env = await one(
    supabase.from('signature_envelopes').select('storage_path, executed_path, certificate_path')
      .eq('id', envelopeId).maybeSingle()
  );
  const paths = [
    env?.storage_path, env?.executed_path, env?.certificate_path,
    ...(signers || []).map((s) => s.signature_path),
  ].filter(Boolean);
  // Sweeps the `documents` rows (entity_type 'envelope') AND every path above.
  await deleteDocumentsFor('envelope', envelopeId, [...new Set(paths)]);
  // ⚠ THE CHILDREN GO EXPLICITLY, not by relying on ON DELETE CASCADE (0085). The cascade is
  // real and correct in Postgres — but the demo mock has no foreign keys, so a cascade-only
  // delete would leave orphaned signers and events in the sandbox while working perfectly
  // live. That is exactly the class of drift CLAUDE.md §3 is about, and doing it explicitly
  // costs two statements and makes both behave identically.
  await rows(supabase.from('envelope_events').delete().eq('envelope_id', envelopeId));
  await rows(supabase.from('envelope_signers').delete().eq('envelope_id', envelopeId));
  await rows(supabase.from('signature_envelopes').delete().eq('id', envelopeId));
}

// Pull a document back before anyone has signed it. The link stops working because the
// function refuses any status other than 'sent' — the token itself is left in place rather
// than blanked, so the audit trail still shows which link was cancelled.
export async function voidEnvelope(envelopeId) {
  await rows(supabase.from('signature_envelopes').update({ status: 'voided' }).eq('id', envelopeId));
  await rows(supabase.from('envelope_events').insert({
    owner_id: await ownerId(), envelope_id: envelopeId, kind: 'voided', actor: 'landlord',
  }));
}

// Dated trail on the property History. Best-effort (logHistoryEvent swallows errors) — a
// history row must never be able to undo a signature that actually happened.
export async function logSignatureEvent({ propertyId, leaseId, tenantName, type, title, signerName }) {
  return logHistoryEvent({
    property_id: propertyId,
    lease_id: leaseId || null,
    tenant_name: tenantName || null,
    type,
    description: type === 'signature_executed'
      ? `“${title}” signed by both parties${signerName ? ` — ${signerName}` : ''}`
      : `“${title}” sent to ${signerName || 'the tenant'} for signature`,
    event_date: paymentIsoToday(),
    meta: { title: title || null, signer: signerName || null },
  });
}

export const createCorporation = async (name) =>
  one(supabase.from('corporations').insert({ name, owner_id: await ownerId() }).select().single());

// Edit a corporation, including its email "sender identity" (name/address/contacts).
export const updateCorporation = (id, patch) =>
  one(supabase.from('corporations').update(patch).eq('id', id).select().single());

// Build the letterhead/signature "business" object an email template expects
// from a corporation record (the corporation IS the sending entity).
export const businessFromCorp = (corp) =>
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

// Batched: every property (id/name) grouped by corporation, in ONE query — for the
// corporation-card hover fly-out that jumps straight to a property. Returns a map
// { [corpId]: [{ id, name }] } sorted by name.
export async function listPropertiesByCorps(corpIds) {
  const ids = (corpIds || []).filter(Boolean);
  if (!ids.length) return {};
  const props = await rows(
    supabase.from('properties').select('id,name,corporation_id').in('corporation_id', ids).order('name')
  );
  const map = {};
  for (const p of props || []) (map[p.corporation_id] ||= []).push({ id: p.id, name: p.name });
  return map;
}

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
  // security_deposit (0078) rides along because it is a scalar the CPA package needs per
  // lease and v_tenant_shares deliberately does not carry it. `ai_review` stays OUT for
  // the opposite reason — it is a blob, and every tenant list would download every one.
  'id,owner_id,property_id,tenant_name,square_footage,base_rent,lease_start,lease_termination_date,lease_terms,share_override_pct,source,extraction_status,lease_file_id,created_at,updated_at,roof_responsible,ai_confidence,tenant_email,tenant_contact_name,no_renewal_option,is_active,premises_address,est_cam_annual,est_tax_annual,est_roof_annual,lease_type,security_deposit';

export const listLeases = async (propertyId) => {
  const all = await rows(supabase.from('leases').select(LEASE_LIST_COLS).eq('property_id', propertyId).order('tenant_name'));
  return (all || []).sort(byTermEnd);
};

// Just the saved AI reviews for a property's leases. Deliberately NOT folded into
// LEASE_LIST_COLS: that column list feeds every lease list in the app, and ai_review is
// a blob only two screens read — adding it there would download every review on every
// tenant list forever. Filtering server-side keeps this to the handful of reviewed rows.
export const listLeaseReviews = (propertyId) =>
  rows(supabase.from('leases').select('id,tenant_name,ai_review')
    .eq('property_id', propertyId).not('ai_review', 'is', null));

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

// Run the AI red-flag review over a lease's cached text and save it (leases.ai_review,
// 0069). Click-gated (~2–5¢) and saved, so re-opening the lease page costs nothing.
//
// Writes through updateLease deliberately, NOT the lease page's saveField: that helper
// also re-stamps ai_confidence and extraction_status, which belong to the extraction and
// would be wrong to touch here. A review is advisory metadata — it never moves a figure.
export async function reviewLease(leaseId) {
  const { flags, model } = await invokeFunction('review-lease', { lease_id: leaseId });
  const ai_review = {
    flags: Array.isArray(flags) ? flags : [],
    model: model || null,
    reviewed_at: new Date().toISOString(),
    source: 'review_button',
  };
  await updateLease(leaseId, { ai_review });
  return ai_review;
}

// Mark findings from a saved lease review as read, ONE AT A TIME (George, 2026-08-05: "i
// want to be able to dismiss notifications one at a time within the tenants … make sure the
// badges on the tenant cards respond accordingly").
//
// A STAMP, NOT A DELETE. The flags stay exactly where they are — dismissing says "I have
// read this", not "this was wrong". Deleting them instead would mean re-running the review
// to find out what it had said.
//
// `dismissed_keys` rides INSIDE the existing ai_review jsonb, so there is no migration and
// no second source of truth. A re-review writes a fresh object with no such key, which is
// what makes every flag come back when the document is read again — right, because a new
// read may reach a different conclusion about the very thing that was waved off.
//
// ⚠ AI FLAGS ONLY. The panel's other half (computeLeaseRisks) is recomputed live from the
// records and is deliberately NOT dismissible: an expired certificate silenced here would
// stay silenced while it went on being expired.
export async function setLeaseReviewDismissedKeys(leaseId, review, keys) {
  const next = { ...(review || {}), dismissed_keys: [...new Set(keys)] };
  // The whole-review stamp this replaced (shipped earlier the same day). Dropped on the
  // first write so a row can never carry both stories about what has been read.
  delete next.dismissed_at;
  await updateLease(leaseId, { ai_review: next });
  return next;
}

// Below this a lease's stored transcript isn't a real document — it's a stub or
// nothing. Mirrors MIN_USABLE_TEXT in the cache-lease-text edge function; the two are
// the same judgement and must agree, or the sweep would send a lease for caching that
// the function then declines to touch.
export const MIN_USABLE_TEXT = 500;

export const leaseNeedsText = (lease) => (lease?.lease_text || '').trim().length < MIN_USABLE_TEXT;

// Fill leases.lease_text for a lease whose transcription never landed (the pre-2026-07-21
// big-scan timeout). Writes only that column, refuses to overwrite a usable transcript,
// and costs $0 when the file is a digital PDF or .docx — see the edge function's header.
// `force` is only ever passed by replaceLeaseFile below — the sweep must keep its refusal
// to overwrite a transcript that already looks usable.
export const cacheLeaseText = (leaseId, { force = false } = {}) =>
  invokeFunction('cache-lease-text', { lease_id: leaseId, force });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Review a list of leases in one sweep, caching any lease's text first when it's missing
// (a review over an empty document can only report "no text on file").
//
// Sequential ON PURPOSE. These are paid model reads and the per-user AI rate counter is
// shared across every function (ai_rate_check, 0018 — keyed on user_id alone, no function
// name), so firing 15 in parallel would trip the limit immediately and burn calls on
// retries. One at a time also makes the progress line honest.
//
// Rate limits are retried, not failed: a 429 means "too fast", not "this lease can't be
// reviewed". Any other error is recorded against that lease and the sweep carries on —
// one unreadable document must never abandon the other fourteen.
export async function reviewLeases(leases, { onProgress } = {}) {
  const RATE_WAIT_MS = 20_000; // the limiter's window is 60s; a short wait clears a burst
  const MAX_RATE_RETRIES = 3;
  const results = [];

  const call = async (fn) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e?.status === 429 && attempt < MAX_RATE_RETRIES) {
          await sleep(RATE_WAIT_MS);
          continue;
        }
        throw e;
      }
    }
  };

  for (let i = 0; i < leases.length; i++) {
    const lease = leases[i];
    const name = lease.tenant_name || 'this lease';
    onProgress?.({ done: i, total: leases.length, current: name });
    let cached = false;
    try {
      if (leaseNeedsText(lease)) {
        const res = await call(() => cacheLeaseText(lease.id));
        cached = !res?.skipped;
      }
      const review = await call(() => reviewLease(lease.id));
      results.push({
        id: lease.id,
        tenant_name: name,
        ok: true,
        cached,
        flags: review.flags.length,
        // Carried per lease so the sweep's result list can rank worst-first and say WHICH
        // tenant needs attention rather than a portfolio-wide total. Counted inline rather
        // than through reviewSummary (leaseRisks.js) only to keep api.js free of a lib
        // import; the severity vocabulary is the same LEASE_FLAG_DEFS one.
        high: review.flags.filter((f) => f?.severity === 'high').length,
      });
    } catch (e) {
      results.push({ id: lease.id, tenant_name: name, ok: false, cached, error: e?.message || String(e) });
    }
  }
  onProgress?.({ done: leases.length, total: leases.length, current: null });
  return results;
}

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
  let docPath = null;
  try {
    const docs = await listDocuments('lease', lease.id);
    docPath = docs?.[0]?.storage_path ?? null;
  } catch (_e) { /* same rule — a registry read must never block removal */ }
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
      // Carry the document across, so a departed tenant's original lease is still
      // openable from History ("Open & ask" already works on the cached text).
      // Deliberately NOT deleted with the lease — it is the one file in the app
      // whose loss would be genuinely irreplaceable.
      storage_path: docPath,
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

  // Register the copy before extraction runs. entity_id is null until the review
  // screen saves a lease (createLeaseFromExtraction attaches it) — cancelling the
  // review calls discardDocument(path), which is what stops an abandoned import
  // leaving the file behind. That leak alone produced 40 of the 55 unreachable
  // lease files in the bucket.
  await registerDocument({
    entityType: 'lease', storagePath: path, filename: file.name,
    bytes: file.size ?? null, mime: file.type || null,
  });

  const { extraction, full_text } = await invokeFunction('extract-lease', { lease_file_id: fileRow.id });
  return { lease_file_id: fileRow.id, extraction, lease_text: full_text || null, storage_path: path };
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
export async function createLeaseFromExtraction({ propertyId, leaseFileId, lease, escalations, renewals, abatements, aiConfidence, leaseText, aiReview, storagePath }) {
  // Build the exact rows to write (owner_id is forced server-side inside the RPC).
  const leasePayload = {
    ...lease,
    property_id: propertyId,
    source: 'ai_extracted',
    extraction_status: 'reviewed',
    ai_confidence: aiConfidence ?? null,
    lease_file_id: leaseFileId,
    lease_text: leaseText ?? null,
    // The red-flag review the analyst answered during the same read (0069). Metadata
    // only — it rides create_lease_tx's jsonb_populate_record with no RPC change.
    ai_review: aiReview ?? null,
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
  // The uploaded file has been sitting in the registry with no entity since the
  // import began — this is the moment it gets an owner. (Cancelling the review
  // discards it instead.) Falls back to the lease_files row for a path the caller
  // didn't thread through, so an older import screen still ends up with a copy.
  let docPath = storagePath || null;
  if (!docPath && leaseFileId) {
    const lf = await one(supabase.from('lease_files').select('storage_path').eq('id', leaseFileId).single()).catch(() => null);
    docPath = lf?.storage_path || null;
  }
  await attachDocument(docPath, { entityType: 'lease', entityId: leaseId });
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
    // One builder, shared with both import paths — the free-rent anchor and the
    // option-priced steps come with it rather than being re-derived here.
    const plan = buildScheduleFromExtraction(ex, {
      baseRent: Number(ex?.base_rent?.value) || Number(lease.base_rent) || 0,
      leaseStart: start,
      termEnd: patch.lease_termination_date || lease.lease_termination_date || null,
    });
    if (existingEsc.length === 0) {
      const escs = [...plan.escalations, ...plan.optionSteps]; // months_from_start → real dates
      if (escs.length) {
        await rows(
          supabase.from('rent_escalations').insert(escs.map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled' })))
        );
      }
    }
    if (existingAb.length === 0 && plan.abatements.length) {
      await rows(
        supabase.from('rent_abatements').insert(plan.abatements.map((a) => ({ ...a, lease_id: leaseId, owner_id: uid })))
      );
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
// It also rejects a date that PARSES but doesn't exist: `new Date('2033-04-31T12:00:00')`
// is not NaN — V8 quietly rolls it to May 1 — so the shape regex plus an isNaN check let
// an impossible date straight through to Postgres, which fails the save with `date/time
// field value out of range`. Riders really do print those (Denny's Third Addendum says
// "April 31, 2033").
//
// ⚠ The implementation MOVED to src/lib/isoDate.js — a module with no dependencies, so the
// pure diff lib (newLeaseTerms.js) can guard its date fields without an import cycle back
// into this file. Re-exported here so every existing importer keeps working unchanged.
export { isoDateOrNull };

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
      // The option's year-by-year rent table (0071). This used to be dropped — the comment
      // that justified it ("no schedule column → no migration") predates the column, and
      // 0071 added exactly that. Without it a re-uploaded lease leaves the option with no
      // schedule, so optionScheduleSteps has nothing to materialise when the landlord later
      // confirms the renewal. Stored as the array the reader already speaks; the CHECK on the
      // column requires an array, so an unusable read stores null rather than a bare object.
      rent_schedule: Array.isArray(r.rent_schedule) && r.rent_schedule.length ? r.rent_schedule : null,
      notes,
    };
  });
}

// Turn AI-extracted renewal OPTION rent schedules into DATED, scheduled rent_escalations
// that sit PAST the committed term end — so an option priced YEAR BY YEAR (e.g. Busey's
// Exhibit D, five stepped installments over a 5-year option) shows its projected rent under
// the lease page's muted "Pending renewal — if renewed" group instead of "Not listed". These
// steps are gated everywhere by the committed term end (applyDueEscalations skips them, the
// ledger / rent-roll / currentPhase ignore them, Ask-AI facts exclude them) until the option
// is actually confirmed — confirmRenewal extends the term, which releases them onto the
// schedule on their own dates. buildRenewals deliberately does NOT store these on the
// renewal_options row (no schedule column → no migration); the option's own new_rent (filled
// by the edge fn from the first option year) is what the Renewal Options tab reads.
//
//   renewalOptions — the extraction's renewal_options; an option may carry a normalized
//                    rent_schedule [{ months_from_option_start, annual }] (edge-annualized)
//   termEnd        — the lease's committed termination date (YYYY-MM-DD) or null
//   existingSteps  — escalation rows already built for this lease (buildEscalations output),
//                    so a boundary a printed table already covers is never double-booked
//   today          — for the past-window guard
// Returns rent_escalations-insert rows { effective_date, escalation_type:'manual',
// escalation_value:null, new_base_rent }, or [] when there's nothing to add.
export function buildRenewalScheduleSteps(renewalOptions, termEnd, existingSteps = [], today = new Date()) {
  const end = isoDateOrNull(termEnd);
  if (!end) return []; // no committed term end → can't place option windows (option still shows its new_rent)
  const options = (Array.isArray(renewalOptions) ? renewalOptions : []).filter(
    (o) => o && Array.isArray(o.rent_schedule) && o.rent_schedule.length
  );
  if (!options.length) return [];

  // Option 1's window begins the day AFTER the committed term ends. The +1 day is load-
  // bearing: portfolio.js gates un-exercised option rent with `d > end` while every other
  // gate uses `>=`, so a step dated exactly ON the term end would leak into Ask-AI facts.
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return localDateIso(d); };
  const daysApart = (a, b) => Math.round(Math.abs(new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
  const todayIso = localDateIso(today);
  const dated = (Array.isArray(existingSteps) ? existingSteps : []).filter((e) => e && e.effective_date);
  const hasStepNear = (iso) => dated.some((e) => daysApart(String(e.effective_date), iso) <= 45);

  const ordered = [...options].sort(cmpRenewal);
  const out = [];
  const emitted = []; // dates already emitted this batch (dedupe chained options too)
  let windowStart = addDays(end, 1);
  for (const opt of ordered) {
    // Past-window guard: if this option's window has already begun, imported clause-rents
    // must NOT read as evidence the tenant exercised it — bail (matches
    // reconcileRenewalOptions' applied-marking semantics; a past option is caught up via
    // rollLeaseIntoRenewal, not synthesized here).
    if (windowStart <= todayIso) break;
    const scheduleRows = opt.rent_schedule
      .map((r) => ({ off: Math.trunc(Number(r?.months_from_option_start) || 0), annual: Number(r?.annual) }))
      .filter((r) => isFinite(r.annual) && r.annual > 0)
      .sort((a, b) => a.off - b.off);
    for (const r of scheduleRows) {
      const d = addMonths(windowStart, r.off);
      if (!d) continue;
      if (hasStepNear(d) || emitted.some((s) => daysApart(s, d) <= 45)) continue;
      out.push({ effective_date: d, escalation_type: 'manual', escalation_value: null, new_base_rent: r.annual });
      emitted.push(d);
    }
    windowStart = addMonths(windowStart, Number(opt.term_months) || 12); // chain the next option's window
  }
  return out;
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

// ---- Dated CAM & tax estimates (0089) ---------------------------------------
// The estimate's answer to rent_escalations. A rent change has always had a dated ledger;
// the estimate was one scalar on the lease, so raising it in August retroactively re-priced
// January — including months the tenant had already paid. George, 2026-08-04: *"the previous
// months aren't affected and shouldn't be reconciled at the new figures because they would be
// part of the old lease."*
//
// ⚠ An EMPTY ledger is the norm and is not a gap: monthlyEstimates falls back to the lease's
// scalar for every month, which is byte-for-byte the behaviour that existed before 0089.
// Rows are written only by a change that CARRIES a date — a new lease, a rider — never by the
// deliberate estimate editors, where the landlord typed this year's figure meaning all of it.
export const listLeaseEstimates = (leaseId) =>
  rows(supabase.from('lease_estimates').select('*').eq('lease_id', leaseId).order('effective_date'));

// Bulk for a whole property in ONE query, mirroring listAbatementsForLeases — the Ledger roll
// prices every tenant at once and must not fan out per lease.
export async function listLeaseEstimatesByLeases(leaseIds) {
  const ids = [...new Set((leaseIds || []).filter(Boolean))];
  const byLease = Object.fromEntries(ids.map((id) => [id, []]));
  if (ids.length === 0) return byLease;
  const all = await rows(supabase.from('lease_estimates').select('*').in('lease_id', ids).order('effective_date'));
  for (const e of all || []) (byLease[e.lease_id] ||= []).push(e);
  return byLease;
}

export const createLeaseEstimate = async (e) =>
  one(supabase.from('lease_estimates').insert({ ...e, owner_id: await ownerId() }).select().single());

// ---- Has the stored invoice fallen behind the lease? ------------------------
// THE INVOICE IS A FROZEN COPY AND DOES NOT REBUILD ITSELF (CLAUDE.md §1). Every JS path that
// moves a billed figure now calls the carry-through — but the rent-step sweep also runs
// **server-side, nightly, in SQL** (`apply_due_escalations()`, 0024/0047), where no JS runs at
// all. Porting ~140 lines of billing math into Postgres to fix that would create a second
// implementation of the money to keep in step, which is the failure CLAUDE.md §3 is about.
//
// So instead of chasing every writer, MEASURE THE RESULT: the schedule built up from live data
// says what the year should be, the stored invoice says what it was billed at, and any gap
// between them is drift — whatever caused it, including causes nobody has thought of. Positive
// = the lease says MORE than the invoice (a step applied and the bill never followed).
//
// George's own framing, and the reason this SHOWS rather than silently rewrites: *"the user
// will have to recalculate when they get their next months statement."*
//
// ±$1 of dust is ignored — the schedule penny-folds and the invoice rounds independently.
export const INVOICE_DRIFT_DUST = 1;
function invoiceDrift(invoice, scheduleAnnual) {
  if (!invoice || invoice.total_amount == null) return 0;
  const gap = round2(Number(scheduleAnnual || 0) - Number(invoice.total_amount || 0));
  return Math.abs(gap) > INVOICE_DRIFT_DUST ? gap : 0;
}

// The monthly arrays buildLeaseSchedule / componentizeSchedule want, or null when there is no
// share to price against (the invoice-fallback branches, whose stored figures were already
// segmented when the invoice was written and must not be re-segmented on top).
const estimateMonths = (estimates, share, year) =>
  (share ? monthlyEstimates(estimates, share, year) : null);

// The single array buildLeaseSchedule wants for `otherByMonth`: CAM & tax + roof combined,
// as an annual rate per month. Null for a gross lease (its expenses are inside the flat rent,
// so nothing rides on top) and null with no share to price against — both cases in which the
// caller's existing flat `otherAnnual` is already the right answer.
function otherMonthsFor(estimates, share, year, billed) {
  if (!share || billed?.gross) return null;
  const m = estimateMonths(estimates, share, year);
  return m ? m.camTax.map((c, i) => round2(c + (Number(m.roof[i]) || 0))) : null;
}

// ---- One rent schedule, built one way --------------------------------------
// Everything a lease document says about MONEY OVER TIME, turned into the rows that get
// written: the free-rent windows, the dated rent steps, the renewal options, and the
// year-by-year rent an option prices for a term nobody has committed to yet.
//
// George, 2026-08-04: *"if the rent escalation in the new lease is found the ledger needs to
// show, the lease terms need to update, the renewal options need to update. the lease
// extractor needs to be as good as the original one we made for the new tenants."*
//
// He is describing a gap that existed because this logic was written FOUR times — the
// new-tenant import (LeaseNewPage), its review preview (SchedulePreview), anchorLeaseSchedule
// and the new-lease-over-an-existing-one path — and the fourth copy was the thin one. It
// dated its steps from the lease start instead of rent commencement, and never built the
// option-priced steps at all. That is exactly the drift CLAUDE.md §3 is about: two
// implementations of one rule always separate. Now there is one, and all four call it.
//
// THE THREE RULES IT ENCODES, none of which are obvious from a call site:
//
//   1. A free-rent window with no printed start begins at the lease start. Undated windows
//      are dropped by buildAbatements, so without this a "first two months free" clause that
//      names no dates is simply lost.
//   2. Paid rent COMMENCES after any leading free period, so a rent table printed by lease
//      year ("Year 1 … Year 5") is anchored THERE, not at the lease start. Anchor it wrong
//      and every step in the lease is dated early — the ledger bills the step-up before the
//      tenant owes it.
//   3. An option priced year by year becomes dated steps PAST the committed term end, gated
//      as "pending renewal" everywhere until the option is confirmed
//      (see buildRenewalScheduleSteps). Without them the Renewal Options tab knows the option
//      exists but the ledger shows "Not listed" for every year of it.
//
//   extraction — the raw AI read
//   baseRent / leaseStart / termEnd — what the lease WILL BE (newLeaseTargets), not what the
//                                     document says in isolation: a field the document is
//                                     silent on keeps the lease's own value.
//
// Returns the rows to insert plus what the landlord needs told: how many months of free rent
// pushed rent commencement, and how many printed steps could NOT be dated (`undated` is
// measured as stated-minus-built, so it can never disagree with what actually lands).
export function buildScheduleFromExtraction(extraction, { baseRent, leaseStart, termEnd, today = new Date() } = {}) {
  const ex = extraction || {};
  const start = isoDateOrNull(leaseStart);
  const rawAbs = Array.isArray(ex.abatements) ? ex.abatements : [];

  const abatements = buildAbatements(rawAbs.map((a) => ({ ...a, start_date: a.start_date || start })));
  const freeMonths = leadingFreeMonths(start, rawAbs);
  const rentStart = freeMonths > 0 && start ? (addMonths(start, freeMonths) || start) : start;

  const escalations = buildEscalations(baseRent, ex.escalations, rentStart);
  const optionSteps = buildRenewalScheduleSteps(ex.renewal_options, termEnd, escalations, today);
  const renewals = buildRenewals(ex.renewal_options);

  const statedSteps = Array.isArray(ex.escalations) ? ex.escalations.length : 0;
  return {
    abatements,
    escalations,
    optionSteps,
    renewals,
    rentStart,
    freeMonths,
    undated: Math.max(0, statedSteps - escalations.length),
  };
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
  const [corporations, properties, leases, insurance, contracts, contractSteps, renewals, balances, escalations, abatements, annualReports] =
    await Promise.all([
      rows(supabase.from('corporations').select('id,name,address')),
      rows(supabase.from('properties').select('id,name,address,corporation_id,building_sf')),
      rows(supabase.from('leases').select('id,tenant_name,tenant_email,tenant_contact_name,premises_address,property_id,square_footage,base_rent,lease_start,lease_termination_date,is_active,roof_responsible,lease_terms,lease_type,updated_at,created_at')),
      rows(supabase.from('insurance_policies').select('id,party,property_id,lease_id,insurer,expiry_date,additional_insured,archived_at,updated_at,created_at').is('archived_at', null)),
      // Widened 2026-08-05: the assistant could not answer "when do I have to give notice
      // on the snow contract?" at all, because the notice terms were never in the snapshot.
      rows(supabase.from('service_contracts').select('id,name,property_id,service_type,vendor,amount,frequency,start_date,end_date,auto_renew,notice_days,notice_by_date,renewal_term_months,updated_at,created_at')),
      // ⚠ The fingerprint below reads service_contracts.updated_at, so a bare FEE-STEP edit
      // would not flip it and every cached answer would keep quoting the old fee. The steps
      // are in the snapshot AND in the fingerprint for that reason.
      rows(supabase.from('contract_escalations').select('contract_id,effective_date,new_amount,updated_at,created_at')),
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
    corporations, properties, leases, insurance, contracts, contractSteps, renewals, balances,
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
    const { answer, needs_docs, draft_for } = await invokeFunction('ask-portfolio', { question, snapshot: snapshotText, snapshot_obj: snapshot });
    return { answer, fromCache: false, needsDocs: !!needs_docs, draftFor: draft_for || null };
  }

  const fingerprint = snapshot?.fingerprint || snapshotFingerprint({});
  const cached = await getCachedPortfolioAnswer(questionNorm, fingerprint);
  // A cached answer never carries needs_docs (we don't persist the flag) — that's
  // fine: the ghost "read the documents instead" link is always available, and a
  // repeat of a fact-answerable question doesn't need the docs button anyway.
  if (cached) return { answer: cached, fromCache: true, needsDocs: false, draftFor: null };

  const { answer, needs_docs, draft_for } = await invokeFunction('ask-portfolio', { question, snapshot: snapshotText });
  // A "write to this tenant" answer is NOT cached: the cache stores the answer text only,
  // so a hit would come back without draft_for and silently lose the ✉ button — and
  // drafting is click-gated and paid for anyway, so there is nothing to save by caching it.
  if (!draft_for) {
    try {
      await writeCachedPortfolioAnswer(questionNorm, fingerprint, answer);
    } catch {
      /* caching is best-effort — never fail the answer on a cache write */
    }
  }
  return { answer, fromCache: false, needsDocs: !!needs_docs, draftFor: draft_for || null };
}

// Draft a personalised tenant letter from a plain-English request in Ask Amlak.
// Click-gated (~1–2¢). The model writes the prose; the letterhead/date/To/RE/signature
// come from the same letter() scaffold every built-in template uses, so the draft is
// ready to send from the compose modal (Gmail, another mail app, or Send now).
export async function draftTenantEmailFromAsk(request, tenant) {
  if (!request?.trim() || !tenant) throw new Error('Nothing to draft.');
  const corp = tenant.corpId ? await getCorporation(tenant.corpId) : null;
  const business = businessFromCorp(corp);
  const { subject, body } = await invokeFunction('draft-tenant-email', {
    request: request.trim(),
    tenant,
    business_name: business?.company_name || '',
  });
  const email = buildAiDraftEmail({
    business,
    tenant_name: tenant.tenant,
    contact_name: tenant.contact_name,
    tenant_email: tenant.email,
    propertyName: tenant.property,
    subject,
    bodyProse: body,
  });
  return {
    title: `Email ${tenant.tenant}`,
    from: business?.contact_email || '',
    to: email.to,
    subject: email.subject,
    body: email.body,
  };
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

// ---- The document registry (every uploaded file, kept and openable) --------
//
// George, 2026-07-30: "need to come up with a way to save copies of things that
// are uploaded like insurance, riders, leases and any file that uploads like the
// bank statements."
//
// Before this, some upload paths saved the file's location, some threw it away,
// one never stored the file at all — and NOTHING in the app ever deleted a file.
// Two-thirds of the bucket was unreachable garbage while the documents he wanted
// to open had no button to open them.
//
// The fix is one table (`documents`, migration 0070) written by the ONE upload
// helper below, so a file can no longer exist without a row naming it. The
// STORAGE PATH is the key throughout — every caller already holds it, so nothing
// needs new id plumbing to attach or discard a file later.
//
// entity_id is nullable on purpose: an importer uploads before its record exists.
// The review screen calls attachDocument on save; cancel calls discardDocument,
// which removes the file AND the row. An explicit cancel is the only thing that
// ever deletes an uploaded file — no cron, nothing silent.

// ⚠ Must hold every value the DB's own CHECK allows, or registerDocument THROWS on a type
// the database would have accepted. 'property' (0081) and 'envelope' (0085) were added to
// the CHECK and never here.
const DOC_ENTITY_TYPES = new Set([
  'lease', 'addendum', 'insurance_policy', 'service_contract',
  'statement_import', 'annual_report', 'property', 'envelope',
]);

// Upload a document to storage (shared bucket) and register it. Returns its
// storage path — unchanged from before, so every existing caller still works;
// passing `meta` is what makes the copy retrievable afterwards.
export async function uploadDoc(file, meta = {}) {
  validateUploadFile(file);
  const uid = await ownerId();
  const safe = file.name.replace(/[^\w.-]+/g, '_');
  const path = `${uid}/${Date.now()}-${safe}`;
  const up = await supabase.storage.from('lease-documents').upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (up.error) throw up.error;

  if (meta.entityType) {
    await registerDocument({
      entityType: meta.entityType,
      entityId: meta.entityId ?? null,
      storagePath: path,
      filename: file.name,
      bytes: file.size ?? null,
      mime: file.type || null,
      label: meta.label ?? null,
      note: meta.note ?? null,
    });
  }
  return path;
}

// Record a file that already lives in storage. Idempotent on (entity, path) so a
// retry can't double-list the same document.
export async function registerDocument({
  entityType, entityId = null, storagePath, filename = null,
  bytes = null, mime = null, label = null, note = null,
}) {
  if (!storagePath) return null;
  if (!DOC_ENTITY_TYPES.has(entityType)) throw new Error(`Unknown document type "${entityType}".`);
  const uid = await ownerId();
  const existing = await rows(
    supabase.from('documents').select('id').eq('storage_path', storagePath).limit(1)
  );
  if (existing?.length) return existing[0];
  return one(
    supabase.from('documents').insert({
      owner_id: uid, entity_type: entityType, entity_id: entityId,
      storage_path: storagePath, filename, bytes, mime, label, note,
      // Stamped rather than left to the column default: the list is ordered newest
      // first, and the demo store has no defaults, so an unstamped row would sort
      // as though it had no date at all.
      created_at: new Date().toISOString(),
    }).select().single()
  );
}

// Every document kept for one record, newest first — the version history.
export const listDocuments = (entityType, entityId) => {
  if (!entityType || !entityId) return Promise.resolve([]);
  return rows(
    supabase.from('documents').select('*')
      .eq('entity_type', entityType).eq('entity_id', entityId)
      .order('created_at', { ascending: false })
  );
};

// A review flow finished: point the file it uploaded at the record it just created.
export async function attachDocument(storagePath, { entityType, entityId }) {
  if (!storagePath || !entityId) return null;
  const patch = { entity_id: entityId };
  if (entityType) patch.entity_type = entityType;
  const updated = await rows(
    supabase.from('documents').update(patch).eq('storage_path', storagePath).select()
  );
  // A file uploaded before this feature shipped (or by a path that didn't register)
  // still gets a row, so nothing that reaches a record stays unlisted.
  if (!updated?.length && entityType) {
    return registerDocument({ entityType, entityId, storagePath });
  }
  return updated?.[0] ?? null;
}

// Remove the stored file itself. Best-effort by design: the caller has already
// decided the file is going, and a storage hiccup must not strand the row.
export async function removeStorageObjects(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  try {
    await supabase.storage.from('lease-documents').remove(list);
  } catch (_e) { /* the registry row is removed regardless — nothing points at it */ }
}

// Throw a just-uploaded file away (cancelled review) — file AND row.
export async function discardDocument(storagePath) {
  if (!storagePath) return;
  await rows(supabase.from('documents').delete().eq('storage_path', storagePath));
  await removeStorageObjects([storagePath]);
}

// ---- The signed copy (0092) --------------------------------------------------
// George, 2026-08-05: *"after the contract is signed the signed copy should be saved as a
// pdf in the contracts tab - that should be the same of the leases in the respective tab
// as well."*
//
// ONE nullable column on `documents` — the registry every uploaded file for every record
// type already files into — so contracts, leases, riders and insurance certificates all
// get this at once, which IS the "and the same on the leases" half of the ask. Keyed by
// document id rather than by entity, so these work for any entity_type without a branch.
//
// Deliberately not exclusive: marking one copy signed does NOT unmark the others. An
// amended contract legitimately has an original signed copy and a signed amendment, and
// deciding for the landlord which of two executed documents is "the" one would be wrong.
export const markDocumentSigned = (id, when = null) =>
  one(supabase.from('documents').update({ signed_at: when || new Date().toISOString() }).eq('id', id).select().single());

export const unmarkDocumentSigned = (id) =>
  one(supabase.from('documents').update({ signed_at: null }).eq('id', id).select().single());

// Delete one saved version from a record's document list (the ✕ button).
export async function deleteDocument(id) {
  const doc = await one(supabase.from('documents').select('*').eq('id', id).single());
  await rows(supabase.from('documents').delete().eq('id', id));
  await removeStorageObjects([doc?.storage_path]);
  return doc;
}

// The lease's CURRENT document is going, and its cached text goes with it — George,
// 2026-08-04: *"there should be a remove button which pops up and says delete file
// (deleting this file will also cause the saved text to delete as well)"*.
//
// leases.lease_text is a transcription OF that file. Leaving it behind would keep the
// assistant answering out of a document the landlord has just removed, quoting clauses
// from something nobody can open — so the two leave together and the dialog can say so
// truthfully. Re-adding a file (or pasting the text back) is the way back.
//
// DELIBERATELY UNTOUCHED — nothing on the money spine moves:
//   • lease_file_id and the linked lease_files row, because extraction_raw on it still
//     feeds getLeaseStatedEstimate (the CAM / tax estimate pre-fill) and
//     reconcileRenewalOptions. Deleting a FILE must not quietly disarm either;
//   • every figure the AI already wrote INTO the lease — rent, dates, square footage,
//     terms — which are the lease's own fields now, not the document's;
//   • the riders, which carry their own text and their own files.
//
// One knock-on is real and left alone on purpose: the lease now reads as "needs text" to
// the Review-leases sweep, whose cache-lease-text call finds a lease_files.storage_path
// pointing at the object we just removed. That path already answers with a plain
// "No document is on file for this lease" (it is the same state as the ~40 leases whose
// files went in the 2026-07-30 storage cleanup) rather than a download error.
export async function deleteLeaseFile(docId, leaseId) {
  if (docId) await deleteDocument(docId);
  if (leaseId) await updateLease(leaseId, { lease_text: null });
}

// Upload a NEW lease over the one on file, read it, and hand back what it would change.
// George, 2026-08-04: *"when a lease is reuploaded … it is recached and lets the user know
// what will be happening and give them an option to remove the old lease or keep it on
// file, but you should automatically recache with the new lease and let them know"* — then,
// correcting the first cut: *"well if i replace a lease with a new one id want the figures
// to change based on the new lease thats the point so it should say 'upload new lease'."*
//
// He is right, and the first version was wrong: it swapped the document and re-read the
// text but left every figure alone, so the app would show one rent and the document beside
// it would say another. A new lease IS new terms.
//
// This function stops at READING. It writes the file, the wiring and the text — never a
// figure. What it changes is returned for the caller to show, and applyNewLeaseTerms below
// is what commits it, after the landlord has seen the list. That split is deliberate:
// base rent and square footage are billed figures (CLAUDE.md §1), and "the figures change"
// must never mean "the figures changed and nobody said which".
//
// Before this there was no way to do it at all: the panel offered "Add a file" ONLY when
// the lease had none, and a file added that way was invisible to cache-lease-text, which
// reads leases.lease_file_id → lease_files.storage_path and never looks at the documents
// registry. So a second upload changed the list and nothing else — the assistant kept
// answering out of the old document with no sign anything had happened.
//
// ⚠ THE lease_files ROW IS UPDATED IN PLACE rather than replaced, and that is the whole
// trick. `extraction_raw` on that row still feeds getLeaseStatedEstimate (the CAM / tax
// estimate pre-fill) and reconcileRenewalOptions. Pointing lease_file_id at a fresh row
// would blank both of them silently — a figure going quietly stale, which is exactly the
// failure the standing instruction is about. Only the path and the filename move.
//
// Order matters: the new file is stored, wired up and registered BEFORE anything is
// deleted, so a failure halfway through leaves the landlord with more than he started
// with rather than less.
export async function uploadNewLeaseDocument({ leaseId, file, oldDocId = null, keepOld = true }) {
  if (!leaseId) throw new Error('A lease is required.');
  validateUploadFile(file);
  const uid = await ownerId();
  const safe = file.name.replace(/[^\w.-]+/g, '_');
  const path = `${uid}/${Date.now()}-${safe}`;

  const up = await supabase.storage.from('lease-documents').upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (up.error) throw up.error;

  const lease = await one(
    supabase.from('leases').select('lease_file_id').eq('id', leaseId).maybeSingle()
  );
  let leaseFileId = lease?.lease_file_id || null;
  if (leaseFileId) {
    await rows(
      supabase.from('lease_files')
        .update({ storage_path: path, original_filename: file.name })
        .eq('id', leaseFileId)
    );
  } else {
    // A lease that never had a file — a pasted-text import, or one whose row went in an
    // older cleanup. It gets a row now, which is what makes it cacheable at all.
    const row = await one(
      supabase.from('lease_files')
        .insert({ owner_id: uid, storage_path: path, original_filename: file.name })
        .select().single()
    );
    leaseFileId = row?.id || null;
    if (leaseFileId) await updateLease(leaseId, { lease_file_id: leaseFileId });
  }

  await registerDocument({
    entityType: 'lease', entityId: leaseId, storagePath: path, filename: file.name,
    bytes: file.size ?? null, mime: file.type || null,
  });

  // The old copy goes only if he said so, and only once the new one is safely in place.
  if (!keepOld && oldDocId) await deleteDocument(oldDocId);

  // ONE read does both jobs — the same call the import screen makes. extract-lease returns
  // the terms AND the plain text, so re-reading the document a second time through
  // cache-lease-text would be a second paid pass over the identical file.
  const { extraction, full_text } = await invokeFunction('extract-lease', { lease_file_id: leaseFileId });

  let length = 0;
  const fresh = (full_text || '').trim();
  if (fresh) {
    await updateLease(leaseId, { lease_text: fresh });
    length = fresh.length;
  } else {
    // No text came back with the terms (it happens on a big scan). Fall back to the
    // dedicated transcriber, forced — the lease still holds the PREVIOUS document's
    // transcript, and its "don't overwrite a usable copy" guard would otherwise skip the
    // one thing that has to happen here.
    const cached = await cacheLeaseText(leaseId, { force: true }).catch(() => null);
    length = Number(cached?.length) || 0;
  }

  return { storage_path: path, lease_file_id: leaseFileId, extraction: extraction || null, length };
}

// Commit the new lease's terms — the half that moves money, kept separate from the read so
// nothing is written until the landlord has seen the list of what changes.
//
// `changes.fields` comes straight from newLeaseChanges (src/lib/newLeaseTerms.js), which is
// what the dialog rendered. Applying THAT rather than re-deriving from the extraction is
// deliberate: what he approved and what gets written are the same object, so the two can't
// drift apart.
//
// ── The carry-through (CLAUDE.md §1) ─────────────────────────────────────────────────────
// The Ledger and the Financials breakdown build UP from live data, so they follow a rent or
// size change on their own. THE STORED INVOICE DOES NOT — it is a frozen copy. So a change
// to base rent, square footage or either term date ends in a resync, and which resync
// depends on whether the property has a building size:
//
//   building_sf set   → the denominator is fixed; only this tenant's share moved.
//   building_sf null  → the denominator is Σ leased SF; re-sizing one tenant re-splits
//                       EVERY tenant on the property.
//
// Both skip a closed year, so a bill already sent can't move under the landlord.
// `plan` is buildScheduleFromExtraction's output — the same object the review dialog showed
// the dated steps and options out of. Passing it through rather than rebuilding it here is
// the same rule as `changes.fields`: what the landlord approved and what gets written are
// one object. It falls back to building its own so the function stays callable on its own.
export async function applyNewLeaseTerms({ leaseId, changes, extraction, plan = null, today = new Date() }) {
  const uid = await ownerId();
  const lease = await getLease(leaseId);
  if (!lease) throw new Error('That lease no longer exists.');

  const NUMERIC = new Set(['base_rent', 'square_footage', 'security_deposit', 'est_cam_annual']);
  const patch = {};
  for (const f of changes?.fields || []) {
    patch[f.key] = NUMERIC.has(f.key) ? Number(f.to) : (f.to === '' ? null : f.to);
  }
  // The CAM & tax estimate is stored MERGED — the combined figure on est_cam_annual with
  // est_tax_annual zeroed — because that is the one convention every reader of it assumes
  // (LeaseForm:73, applyAddendumChanges:2209, the Financials estimate save). Writing the
  // combined figure while leaving the old tax estimate beside it would double-count the
  // tax half into every month of the invoice. est_confirmed_year stamps the estimate as
  // belonging to THIS year, which is what clears the Financials "carried over" note.
  if (patch.est_cam_annual != null) {
    patch.est_tax_annual = 0;
    patch.est_confirmed_year = Number(localDateIso(today).slice(0, 4));
  }
  // The confidence badges and the red-flag review describe a DOCUMENT. Leaving the previous
  // document's behind would caption the new lease with an assessment of a file that is no
  // longer on it — so they move with the document, or are cleared if it came back without.
  if (extraction) {
    patch.ai_confidence = buildAiConfidence(extraction);
    patch.ai_review = extraction.ai_review || null;
  }
  if (Object.keys(patch).length) await updateLease(leaseId, patch);

  // Built from what the lease WILL BE, not from the document in isolation — a figure the new
  // document is silent on keeps the lease's own value, and the rent schedule has to be dated
  // off those same numbers.
  const built = plan || buildScheduleFromExtraction(extraction, { ...newLeaseTargets(lease, changes), today });

  // A new lease's rent schedule supersedes the old one's. Only SCHEDULED steps go — a step
  // already applied is history, and rewriting history is how a past invoice stops matching
  // the ledger that explains it.
  //
  // The option-priced steps ride the same insert: they are rent_escalations too, dated past
  // the committed term end and gated as "pending renewal" until the option is confirmed. The
  // same delete clears the previous document's, so a superseded option's projected rent can't
  // outlive the lease that granted it.
  const escRows = built.escalations;
  const optRows = built.optionSteps;
  await rows(
    supabase.from('rent_escalations').delete()
      .eq('lease_id', leaseId).eq('status', 'scheduled')
  );
  if (escRows.length || optRows.length) {
    await rows(
      supabase.from('rent_escalations').insert(
        [...escRows, ...optRows].map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled' }))
      )
    );
  }

  // ── THE CHANGE HAS A DATE ────────────────────────────────────────────────────────────
  // George, 2026-08-04: *"the rent might change mid way through the year due to a new lease.
  // if that happens it should be recorded as it needs to be in the ledger so that when
  // statements come in the payments match… the previous months aren't affected and shouldn't
  // be reconciled at the new figures because they would be part of the old lease."*
  //
  // Until now this function moved `base_rent` and nothing else, so nothing in the app knew
  // WHEN the rent changed. `monthlyBases` reads the escalation ledger; with no row at the
  // boundary it priced all twelve months at the new rent, and a year already half-billed was
  // silently re-priced under the tenant.
  //
  // TWO rows are needed, not one, and this is the part that is easy to get wrong.
  // monthlyBases returns the LIVE base_rent for any month with no EARLIER applied step
  // (escalations.js — "its true prior rate isn't recoverable once base_rent moved"), so a
  // boundary row alone still leaves January on the new rent. The closing row is what gives
  // the old era a rate of its own:
  //
  //   closing   at the old lease's start (or its last applied step, whichever is later),
  //             carrying the OLD rent — read from the pre-patch lease above.
  //   boundary  at the new lease's start, carrying the NEW rent.
  //
  // The closing row does a second, larger job: occupancyStart is min(lease_start, earliest
  // APPLIED step), so it pulls occupancy back to the real move-in. Without it, moving
  // lease_start forward puts every earlier month OUT of term — which is how the re-stamp
  // loop above came to delete their payments.
  //
  // ⚠ STATUS MATTERS. The closing row is always `applied`: left scheduled, applyDueEscalations
  // would "apply" it on the next load and write the OLD rent back over base_rent. The boundary
  // row is applied only once its date has arrived — a lease signed in August but commencing in
  // October keeps today's rent until October, and backfillLeaseToToday releases it on the day.
  // ⚠ THE CLOSING ROW IS NOT ABOUT THE RENT ALONE. Its second job — pulling occupancyStart
  // back — is needed whenever `lease_start` moves FORWARD, whatever the rent did. Gated on a
  // rent change (as it first was), a renewal at the SAME rent commencing later wrote nothing:
  // occupancyStart jumped to the new start, monthlyScheduleForYear marked every earlier month
  // { owed: 0, outsideTerm: true }, and the resync rebuilt the year's invoice covering only
  // the months from the new start. The payments survived (the zero-owed skip below), but they
  // then read as an unexplained credit against a year the tenant no longer appeared to owe —
  // the opposite of *"so that when statements come in the payments match"*.
  const boundaryIso = isoDateOrNull(patch.lease_start ?? lease.lease_start);
  const oldStartIso = isoDateOrNull(lease.lease_start);
  const oldRent = Number(lease.base_rent) || 0;
  const newRent = Number(patch.base_rent ?? lease.base_rent) || 0;
  const rentChanged = oldRent > 0 && newRent > 0 && Math.abs(newRent - oldRent) >= 0.005;
  const startMovedForward = !!(oldStartIso && boundaryIso && boundaryIso > oldStartIso);
  let eraRows = [];
  if (boundaryIso && oldRent > 0 && (rentChanged || startMovedForward)) {
    const existing = await listEscalations(leaseId);
    const lastApplied = existing
      .filter((e) => e.status === 'applied' && e.effective_date)
      .map((e) => String(e.effective_date)).sort().pop() || null;
    // The old rent's era began at the later of the old term start and its last step.
    const closingIso = [oldStartIso, lastApplied].filter(Boolean).sort().pop() || null;
    // Same ±45-day rule buildRenewalScheduleSteps uses, so a boundary can't double-book a
    // step the new lease already prints on (or near) the same date.
    const dated = [...existing, ...escRows, ...optRows].filter((e) => e?.effective_date);
    const within45 = (list, iso) => list.some((e) => Math.abs(
      new Date(String(e.effective_date) + 'T12:00:00') - new Date(iso + 'T12:00:00')
    ) <= 45 * 86400000);
    const near = (iso) => within45(dated, iso);
    // ⚠ The CLOSING row is deduped only against APPLIED rows. A scheduled row near the old
    // start says nothing about occupancy (occupancyStart reads applied rows only), so letting
    // one suppress the closing row would re-open the hole this block exists to close.
    const nearApplied = (iso) => within45(existing.filter((e) => e.status === 'applied' && e.effective_date), iso);
    const step = (date, rent) => ({ effective_date: date, escalation_type: 'manual', escalation_value: null, new_base_rent: rent });

    // Skipped when the new lease starts EARLIER than the old one — then there is no prior
    // era in the first place, and the new lease's own terms cover the whole span.
    if (closingIso && closingIso < boundaryIso && !nearApplied(closingIso)) eraRows.push(step(closingIso, oldRent));
    // The boundary row only exists to record a NEW RATE. A start that moved with the rent
    // unchanged needs no second row saying the same figure twice.
    if (rentChanged && !near(boundaryIso)) eraRows.push(step(boundaryIso, newRent));

    if (eraRows.length) {
      const todayIso = localDateIso(today);
      await rows(
        supabase.from('rent_escalations').insert(
          eraRows.map((e) => ({
            ...e, lease_id: leaseId, owner_id: uid,
            status: e.effective_date <= todayIso ? 'applied' : 'scheduled',
            applied_at: e.effective_date <= todayIso ? new Date().toISOString() : null,
          }))
        )
      );
    }
  }

  // The CAM & tax estimate gets the SAME treatment (0089): a closing row carrying the old
  // figure and a boundary row carrying the new one, so the months before the change keep
  // being billed — and reconciled — at what the old lease said. Without these two rows the
  // estimate is one scalar and raising it here re-prices January retroactively.
  if (boundaryIso && patch.est_cam_annual != null) {
    const priorEst = leaseCamTaxAnnual(lease);
    // ⚠ `!= null`, NOT Number.isFinite(Number(...)). Number(null) is 0 and Number.isFinite(0)
    // is true, so the old test wrote roof_annual: 0 for a lease that simply had no roof
    // estimate. monthlyEstimates keeps a 0 (its filter is `!= null`), so that invented zero
    // built a roof series where none should exist and priced every month before the boundary
    // at NO roof — for a roof-responsible tenant, money missing from the Ledger and from the
    // year-end true-up, showing up as a rent difference because base is a remainder.
    const priorRoof = lease.est_roof_annual != null ? Number(lease.est_roof_annual) : null;
    const roofVal = Number.isFinite(priorRoof) ? priorRoof : null;
    const existingEst = await listLeaseEstimates(leaseId);
    const closingEstIso = [isoDateOrNull(lease.lease_start), ...existingEst.map((e) => String(e.effective_date))]
      .filter(Boolean).sort().pop() || null;
    const rowsToAdd = [];
    // THE CLOSING ROW IS WRITTEN EVEN WHEN THERE WAS NO PRIOR ESTIMATE (0090). That is the
    // commonest shape of this change — a lease going from "—" to a figure — and it used to be
    // the one case that got no closing row at all, so every month back to January was
    // re-billed at the new estimate. Those months were billed at the tenant's ACTUAL share
    // (billedComponents falls back to cam_amount when no estimate is set), and that is what
    // cam_tax_none tells monthlyEstimates to keep billing them at.
    if (closingEstIso && closingEstIso < boundaryIso) {
      rowsToAdd.push(priorEst != null
        ? {
          effective_date: closingEstIso,
          cam_tax_annual: priorEst, cam_tax_none: false, roof_annual: roofVal,
          source: 'new_lease', note: 'Estimate under the previous lease',
        }
        : {
          effective_date: closingEstIso,
          cam_tax_annual: null, cam_tax_none: true, roof_annual: roofVal,
          source: 'new_lease', note: 'No CAM & tax estimate under the previous lease',
        });
    }
    rowsToAdd.push({
      effective_date: boundaryIso,
      cam_tax_annual: Number(patch.est_cam_annual), cam_tax_none: false, roof_annual: roofVal,
      source: 'new_lease', note: null,
    });
    // NOT swallowed. This write is half of the rule the era rows above implement: if it fails
    // and the rent rows don't, January reads the old rent and the new CAM — a half-applied
    // version of the very thing this round shipped, with nothing on screen to say so. The
    // caller reports the failure and the dialog names it.
    await rows(
      supabase.from('lease_estimates').insert(rowsToAdd.map((r) => ({ ...r, lease_id: leaseId, owner_id: uid })))
    );
  }

  // Same rule one level along: a PENDING option is a right under the old lease and the new
  // one restates it; an exercised or lapsed one is a thing that happened.
  const renRows = built.renewals;
  // ⚠ CARRY THE NOTICE LEAD ACROSS THE REPLACEMENT (0072). notice_lead_n / notice_lead_unit
  // are a LANDLORD setting — how far ahead he wants warning — not a figure any document
  // states, so buildRenewals cannot produce them and a delete-then-insert simply lost them.
  // Matched by position: options are ordered the same way the document lists them, so option
  // 1's lead follows option 1. A new lease granting more options leaves the extras unset,
  // which is the honest answer for an option that didn't exist before.
  const priorPending = (await listRenewals(leaseId))
    .filter((r) => r.status === 'pending')
    .sort(cmpRenewal);
  await rows(
    supabase.from('renewal_options').delete()
      .eq('lease_id', leaseId).eq('status', 'pending')
  );
  if (renRows.length) {
    await rows(
      supabase.from('renewal_options').insert(
        [...renRows].sort(cmpRenewal).map((r, i) => ({
          ...r,
          notice_lead_n: priorPending[i]?.notice_lead_n ?? null,
          notice_lead_unit: priorPending[i]?.notice_lead_unit ?? null,
          lease_id: leaseId, owner_id: uid, status: 'pending',
        }))
      )
    );
  }

  // Abatements are ADDED, never cleared — unlike a scheduled step, an abatement window may
  // already have credited an issued invoice, and deleting it would leave that credit
  // unexplained. A stale window is visible on the lease; an orphaned credit is not.
  // …but an identical window is not added twice. Applying the same document again — after a
  // failure part way through, or a corrected copy of the same lease — used to append a second
  // copy of every free-rent window. Harmless to the money (abatementForMonth takes the
  // strongest overlapping window and leadingFreeMonths takes the max, never the sum) but it
  // leaves the lease page listing the same free period twice, which reads as a mistake.
  const existingAb = await listAbatements(leaseId);
  const abKey = (a) => `${a.start_date}|${a.end_date}|${a.kind}|${a.value ?? ''}`;
  const haveAb = new Set(existingAb.map(abKey));
  const abRows = built.abatements.filter((a) => !haveAb.has(abKey(a)));
  if (abRows.length) {
    await rows(
      supabase.from('rent_abatements').insert(
        abRows.map((a) => ({ ...a, lease_id: leaseId, owner_id: uid }))
      )
    );
  }

  const moved = (changes?.fields || []).map((f) => f.label).join(', ');
  await logHistoryEvent({
    property_id: lease.property_id || null, lease_id: leaseId, type: 'lease_replaced',
    tenant_name: lease.tenant_name || null,
    description: `New lease document applied${moved ? ` — updated ${moved}` : ''}`,
    event_date: localDateIso(today),
    meta: {
      fields: (changes?.fields || []).map((f) => ({ key: f.key, from: f.from ?? null, to: f.to })),
      escalations: escRows.length, renewals: renRows.length, abatements: abRows.length,
      option_steps: optRows.length, free_months: built.freeMonths || 0,
    },
  });

  // ⚠ ROLL THE SCHEDULE FORWARD *BEFORE* THE RESYNC, not after. A new lease routinely prices
  // a step that has already passed — the demo lease commences March 2025 and steps 3% each
  // March, so applying it in August 2026 means the first step is history the moment it lands.
  // backfillLeaseToToday is what applies it and moves base_rent to the real current rent.
  // Rebuilding the invoice first would rebuild it from the rent BEFORE that step, and the
  // lease would then read a rent its own invoice was never built from — a figure going
  // quietly stale one line after it was fixed.
  const rolled = await backfillLeaseToToday(leaseId, today);

  // The invoice does not rebuild itself (CLAUDE.md §1). Last, so one settle covers a rent
  // change, a resize, a new estimate and a new term together rather than firing per effect.
  let resynced = false;
  let resyncScope = null;   // 'lease' | 'property' — the dialog says which, truthfully
  let leasesResynced = 0;
  const sizeChanged = (changes?.fields || []).some((f) => f.key === 'square_footage');
  if (changes?.touchesBilling && lease.property_id) {
    const year = Number(localDateIso(today).slice(0, 4));
    const property = await getProperty(lease.property_id).catch(() => null);
    if (sizeChanged && !(Number(property?.building_sf) > 0)) {
      const res = await resyncPropertyBilling(lease.property_id, year);
      resyncScope = 'property';
      leasesResynced = Number(res?.leases) || 0;
    } else {
      const res = await resyncLeaseBilling(leaseId, lease.property_id, year);
      resyncScope = 'lease';
      leasesResynced = res?.invoice ? 1 : 0;
    }
    resynced = true;
  }

  return {
    fields: (changes?.fields || []).length,
    escalations: escRows.length,
    optionSteps: optRows.length,
    renewals: renRows.length,
    abatements: abRows.length,
    freeMonths: built.freeMonths || 0,
    undated: built.undated || 0,
    // The rent the lease actually ends on, so the dialog can name it rather than leaving the
    // landlord to wonder why it isn't the figure printed on page one of the document.
    currentRent: rolled?.currentRent ?? null,
    resynced,
    resyncScope,
    leasesResynced,
    propertyId: lease.property_id || null,
  };
}

// The same rule one level down: a rider's file and its cached transcription are one
// document, so removing the file removes the text. The RIDER itself stays — its label,
// dates and summary are the lease's record of the amendment, not the document's, and the
// row keeps standing there offering "Add a file".
//
// Both places a rider's file can be recorded are swept: the documents registry AND the
// legacy storage_path column on the rider, which is what the row itself reads.
export async function deleteAddendumFile(addendumId, storagePath = null) {
  if (!addendumId) return null;
  await deleteDocumentsFor('addendum', addendumId, [storagePath]);
  return updateAddendum(addendumId, { storage_path: null, addendum_text: null });
}

// A record is being deleted: take its files with it. Extra paths (a legacy
// storage_path column that never made it into the registry) are swept too.
export async function deleteDocumentsFor(entityType, entityId, extraPaths = []) {
  const docs = entityId ? await listDocuments(entityType, entityId) : [];
  if (docs.length) await rows(supabase.from('documents').delete().eq('entity_type', entityType).eq('entity_id', entityId));
  const paths = [...new Set([...docs.map((d) => d.storage_path), ...extraPaths].filter(Boolean))];
  await removeStorageObjects(paths);
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

/**
 * A RENEWAL: the policy on file moves to history and a new one takes its place.
 *
 * George, 2026-08-05: *"i want a history but able to upload new ones so once a new one is
 * uploaded (not replaced) it is moved to history within that and then the new one is
 * uploaded and read and saved."*
 *
 * ⚠ THIS IS WHAT "REPLACE POLICY" USED TO DESTROY. It called saveInsurance, which UPDATEs
 * the active row in place — so renewing a certificate overwrote the insurer, the coverage
 * limit, the premium, the expiry and the cached text of the year before it. The uploaded
 * FILE survived (it registers under the policy id), but nothing recorded what it said, which
 * is exactly the wrong half to keep: "what were we covered for in 2024" is the question
 * history exists to answer, and the answer was being erased once a year.
 *
 * ⚠ THE ORDER IS FORCED — archive, THEN insert. getPropertyInsurance / getTenantInsurance
 * find the active policy with `.maybeSingle()` on `archived_at is null`, and maybeSingle
 * ERRORS on more than one row. Insert first and there are momentarily two active policies
 * for the scope, so every reader in the app — the card, the alerts, the Ask snapshot —
 * throws until the archive lands. Archive first and the worst case is a scope with no
 * active policy and an intact history row, which the next upload fixes.
 *
 * ⚠ saveInsurance IS STILL THE RIGHT CALL FOR "Edit facts". Correcting a typo in an insurer's
 * name is not a new policy year, and giving it a history entry would bury the real ones.
 *
 * Everything downstream follows on its own, because every reader already filters on
 * `archived_at is null`: the superseded policy stops raising expiry alerts (`fetchAlertData`),
 * stops emailing (`send-reminders`), and drops out of the Ask snapshot — while its row, its
 * certificate and its extra documents stay exactly where they are. The NEW row starts with a
 * null `expiry_notice_bucket`, so the reminders re-arm for the new date.
 */
export async function supersedeInsurance({ party, propertyId, leaseId, ...fields }) {
  const uid = await ownerId();
  const current = party === 'landlord'
    ? await getPropertyInsurance(propertyId)
    : await getTenantInsurance(leaseId);
  if (current?.id) await archiveInsurance(current.id);
  const created = await one(
    supabase.from('insurance_policies').insert({
      owner_id: uid,
      party,
      property_id: propertyId ?? null,
      lease_id: leaseId ?? null,
      ...fields,
    }).select().single()
  );
  return { policy: created, supersededId: current?.id || null };
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

// Remove policy → "Delete permanently": drop the row (its documents cascade) and
// take the stored certificates with it. "Save to history" (archiveInsurance,
// above) deliberately keeps both — only an explicit permanent delete removes files.
export async function deleteInsurance(id) {
  const p = await one(supabase.from('insurance_policies').select('storage_path').eq('id', id).single()).catch(() => null);
  const extras = await listInsuranceDocuments(id).catch(() => []);
  await deleteDocumentsFor('insurance_policy', id, [p?.storage_path, ...extras.map((d) => d.storage_path)]);
  return rows(supabase.from('insurance_policies').delete().eq('id', id));
}

// ---- Extra documents attached to a policy (renewals, premium notices, any PDF)
export const listInsuranceDocuments = (policyId) =>
  rows(supabase.from('insurance_documents').select('*').eq('policy_id', policyId).order('created_at'));

export async function addInsuranceDocument({ policyId, label, file, note }) {
  const storage_path = file
    ? await uploadDoc(file, { entityType: 'insurance_policy', entityId: policyId, label, note })
    : null;
  return one(supabase.from('insurance_documents')
    .insert({ owner_id: await ownerId(), policy_id: policyId, label, storage_path, note: note || null })
    .select().single());
}

export async function removeInsuranceDocument(id) {
  const d = await one(supabase.from('insurance_documents').select('storage_path').eq('id', id).single()).catch(() => null);
  if (d?.storage_path) await discardDocument(d.storage_path);
  return rows(supabase.from('insurance_documents').delete().eq('id', id));
}

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

export const getServiceContract = (id) =>
  one(supabase.from('service_contracts').select('*').eq('id', id).maybeSingle());

export const addServiceContract = async (c) =>
  one(supabase.from('service_contracts').insert({ ...c, owner_id: await ownerId() }).select().single());

// ---- Dated fee steps (contract_escalations, 0091) ---------------------------
// DERIVED, never applied: nothing writes service_contracts.amount, so there is no status
// column and no nightly sweep. contractAnnualCost(contract, year, steps) picks the step in
// effect; an empty list falls back to the scalar amount + escalation_pct exactly as before.
export const listContractEscalations = (contractId) =>
  rows(supabase.from('contract_escalations').select('*').eq('contract_id', contractId).order('effective_date'));

// Steps for a SET of contracts in ONE query — the shape every bulk caller needs so a
// property with eight contracts costs one round trip, never eight.
export async function listContractEscalationsFor(contractIds) {
  const ids = [...new Set((contractIds || []).filter(Boolean))];
  if (!ids.length) return [];
  return rows(supabase.from('contract_escalations').select('*').in('contract_id', ids).order('effective_date'));
}

export async function listContractEscalationsByProperty(propertyId) {
  const contracts = await listServiceContracts(propertyId);
  return listContractEscalationsFor(contracts.map((c) => c.id));
}

// Replace a contract's whole fee schedule. Delete-then-insert is safe HERE in a way it is
// not on rent_escalations: there is no `status`, so no row is history — every step is a
// statement about what the fee is, and the document that supersedes them supersedes all.
export async function replaceContractEscalations(contractId, steps) {
  const uid = await ownerId();
  await rows(supabase.from('contract_escalations').delete().eq('contract_id', contractId));
  const list = (steps || []).filter((s) => s?.effective_date && Number(s.new_amount) >= 0);
  if (!list.length) return 0;
  await rows(
    supabase.from('contract_escalations').insert(
      list.map((s) => ({ ...s, contract_id: contractId, owner_id: uid }))
    )
  );
  return list.length;
}

// The single choke point for a contract edit, which is why both notice derivations live
// here rather than at each caller:
//   • end_notice_bucket is cleared when the END date moves, so the expiry reminder re-arms
//     (the pattern saveInsurance uses for expiry_notice_bucket);
//   • notice_by_date is DERIVED from end_date − notice_days when the caller didn't supply
//     one, because most contracts state the window in prose and print no deadline — and the
//     date is what arms the reminder at all; and
//   • cancel_notice_bucket is cleared whenever that date moves, so a rescheduled notice
//     notifies again instead of being deduped against the old one.
// A notice date the caller DID supply always wins: a contract that prints a real deadline
// beats our arithmetic.
export async function updateServiceContract(id, patch) {
  const body = { ...patch };
  const touchesNotice = 'end_date' in patch || 'notice_days' in patch || 'notice_by_date' in patch;
  if (touchesNotice) {
    const existing = await one(
      supabase.from('service_contracts').select('end_date, notice_days, notice_by_date').eq('id', id).maybeSingle()
    );
    if ('end_date' in patch && existing && patch.end_date !== existing.end_date) body.end_notice_bucket = null;
    if (!('notice_by_date' in patch)) {
      const days = 'notice_days' in patch ? patch.notice_days : existing?.notice_days;
      const end = 'end_date' in patch ? patch.end_date : existing?.end_date;
      // Only ever WRITES a date it can compute; never nulls one already stored. Clearing
      // notice_days on a contract that printed its own deadline must not erase the deadline.
      const derived = noticeDueDate(end, days);
      if (derived && derived !== existing?.notice_by_date) body.notice_by_date = derived;
    }
    const nextNotice = 'notice_by_date' in body ? body.notice_by_date : existing?.notice_by_date;
    if ((nextNotice || null) !== (existing?.notice_by_date || null)) body.cancel_notice_bucket = null;
  }
  return one(supabase.from('service_contracts').update(body).eq('id', id).select().single());
}

// ⚠ Deleting a contract STOPS money that was flowing through CAM, so it carries through
// exactly like applying one does. The FK cascade removes the derived cam_line_items row,
// but nothing re-summed expense_records.cam_total — so the deleted contract's fee stayed in
// the property's CAM, and therefore in every tenant's share and every stored invoice, until
// somebody happened to open that fiscal year's Expenses page.
export async function deleteServiceContract(id, { today = new Date() } = {}) {
  const c = await one(supabase.from('service_contracts').select('storage_path, property_id').eq('id', id).single()).catch(() => null);
  await deleteDocumentsFor('service_contract', id, [c?.storage_path]);
  await rows(supabase.from('service_contracts').delete().eq('id', id));
  const carried = c?.property_id
    ? await carryContractChange(c.property_id, Number(localDateIso(today).slice(0, 4)))
    : { synced: false, resynced: false, leasesResynced: 0 };
  return { propertyId: c?.property_id || null, ...carried };
}

/**
 * The contract → CAM → invoice carry-through (CLAUDE.md §1), in ONE place so every writer
 * runs the identical pair in the identical order.
 *
 * ⚠ THE ORDER IS FORCED. resyncYearBillingToEstimate prices from v_tenant_shares, which
 * reads expense_records.cam_total — and syncContractCamItems is what MOVES that total.
 * Resync first and every invoice is rebuilt from the OLD CAM, then the total moves under it.
 * Same reason backfillLeaseToToday runs before the resync on the lease side.
 *
 * ⚠ AND NOTHING HERE TOUCHES AN ESTIMATE. George, 2026-08-05: *"this only affects the ACTUAL
 * CAM and Tax not estimated."* That holds because billedComponents PREFERS a tenant's
 * estimate and falls back to the actual share: write no estimate and a tenant on one keeps
 * paying it (settling at ⚖ Reconcile), while a tenant without one is billed the new actual
 * now. resyncPropertyBilling skips a CLOSED year outright, so a bill already sent never moves.
 */
async function carryContractChange(propertyId, year) {
  const sync = await syncContractCamItems(propertyId, year);
  if (!sync.changed) return { synced: false, resynced: false, leasesResynced: 0 };
  const res = await resyncPropertyBilling(propertyId, year);
  return {
    synced: true,
    resynced: !res?.skipped,
    leasesResynced: Number(res?.leases) || 0,
    closedYear: res?.skipped === 'closed',
  };
}

// How many tenants at this property already hold a bill for the year — the honest count for
// the review screen's consequence list, because that is exactly the set resyncPropertyBilling
// touches (it rebuilds leases with a non-void ANNUAL invoice, not every tenant).
export async function countBilledTenants(propertyId, year) {
  const list = await rows(
    supabase.from('invoices').select('id, lease_id, status, kind')
      .eq('property_id', propertyId).eq('year', year)
  );
  const ids = new Set(
    (list || [])
      .filter((i) => i.status !== 'void' && (i.kind == null || i.kind === 'annual'))
      .map((i) => i.lease_id)
      .filter(Boolean)
  );
  return ids.size;
}

// ---- A NEW contract document over an existing contract ----------------------
// The contract-side twin of uploadNewLeaseDocument. It stops at READING: it writes the
// file, the wiring and the cached text — never a billed figure. applyNewContractTerms
// below is what commits the terms, after the landlord has seen the list of what changes.
//
// ⚠ contract_text IS WRITTEN HERE, at read time, not at apply. DocAssistant answers "what
// is the cancellation notice?" out of service_contracts.contract_text, so leaving the OLD
// document's transcription in place after a new file is filed is precisely the "one screen
// says X, the document beside it says Y" failure this whole round exists to kill. The text
// belongs to the FILE; the figures belong to the review.
//
// Order matters: the new file is stored, wired up and registered BEFORE anything is
// deleted, so a failure halfway through leaves the landlord with more than he started with
// rather than less.
export async function uploadNewContractDocument({ contractId, file, oldDocId = null, keepOld = true }) {
  if (!contractId) throw new Error('A contract is required.');
  validateUploadFile(file);
  const uid = await ownerId();
  const safe = file.name.replace(/[^\w.-]+/g, '_');
  const path = `${uid}/${Date.now()}-${safe}`;

  const up = await supabase.storage.from('lease-documents').upload(path, file, {
    contentType: file.type || undefined,
    upsert: false,
  });
  if (up.error) throw up.error;

  const existing = await one(supabase.from('service_contracts').select('name').eq('id', contractId).maybeSingle());
  await rows(supabase.from('service_contracts').update({ storage_path: path }).eq('id', contractId));
  await registerDocument({
    entityType: 'service_contract', entityId: contractId, storagePath: path,
    filename: file.name, bytes: file.size ?? null, mime: file.type || null,
  });

  // The old copy goes only if he said so, and only once the new one is safely in place.
  if (!keepOld && oldDocId) await deleteDocument(oldDocId);

  // ONE read does both jobs — the terms AND the plain text. Re-reading the file through a
  // second call would be a second paid pass over the identical document.
  // `name` is passed for the same reason the Add path passes it: it routes the DEMO mock's
  // canned answer to the right kind of contract. The live edge function ignores it.
  const { fields, contract_text } = await extractContract({ storagePath: path, name: existing?.name || '' });
  const fresh = (contract_text || '').trim();
  if (fresh) await rows(supabase.from('service_contracts').update({ contract_text: fresh }).eq('id', contractId));

  return { storage_path: path, extraction: fields || null, length: fresh.length };
}

// ---- Reading a contract that came back SIGNED -------------------------------
/**
 * The countersigned copy, read by the AI. George, 2026-08-05: *"only when its countersigned
 * the user should be prompted with extract info with AI then it should upload."*
 *
 * The twin of uploadNewContractDocument, and it stops at exactly the same place: it reads,
 * it replaces the cached text, and it moves NOT ONE FIGURE. applyNewContractTerms commits
 * the terms, after the landlord has seen the diff.
 *
 * ⚠ IT READS `executed_path`, NOT `storage_path`. The executed PDF is the document plus both
 * signatures plus the certificate — the version that is actually in force. Reading the
 * unsigned draft would risk transcribing terms that were struck out before signing.
 *
 * ⚠ AND IT DOES NOT POINT THE CONTRACT AT THAT FILE. The executed PDF belongs to the
 * envelope: deleteEnvelope sweeps the storage object along with the row, so a
 * service_contracts.storage_path aimed at it would offer "Open" on a file that is gone. The
 * signed copy is SHOWN on the contract row, sourced from the envelope — the identical
 * decision the lease side made in 0092, and for the identical reason. What lands on the
 * contract is the TEXT (so the assistant answers from the signed version) and, once
 * confirmed, the terms.
 */
export async function readSignedContractEnvelope({ envelopeId, contractId }) {
  const env = await one(
    supabase.from('signature_envelopes')
      .select('id, contract_id, status, executed_path').eq('id', envelopeId).maybeSingle()
  );
  if (!env) throw new Error('That signed document no longer exists.');
  if (env.status !== 'executed') throw new Error('That document isn’t signed by both parties yet.');
  if (!env.executed_path) throw new Error('The signed copy isn’t on file yet — try again in a moment.');

  const id = contractId || env.contract_id;
  if (!id) throw new Error('That document isn’t attached to a contract.');
  const contract = await getServiceContract(id);
  if (!contract) throw new Error('That contract no longer exists.');

  // `name` routes the DEMO mock's canned answer to the right kind of contract; the live
  // edge function ignores it. Same reason uploadNewContractDocument passes it.
  const { fields, contract_text } = await extractContract({
    storagePath: env.executed_path, name: contract.name || '',
  });
  const fresh = (contract_text || '').trim();
  if (fresh) await rows(supabase.from('service_contracts').update({ contract_text: fresh }).eq('id', id));

  return { contract, extraction: fields || null, length: fresh.length };
}

/**
 * Mark an executed envelope as acted on.
 *
 * `applied_at` is deliberately separate from `status` (0085): "signed by both parties" and
 * "acted on" are different facts, and collapsing them would make an unread contract look
 * finished. It is what clears the "Read the signed contract" prompt and the dashboard's
 * signature_apply alert — so it is written both when the terms are applied AND when the
 * landlord reads it and decides nothing changes. Both are deliberate acts; only doing the
 * first would leave a correctly-read contract nagging forever.
 */
export const markEnvelopeApplied = (envelopeId) =>
  rows(supabase.from('signature_envelopes')
    .update({ applied_at: new Date().toISOString() }).eq('id', envelopeId));

/**
 * Create a contract FROM a document the landlord has just reviewed — the Add path's commit.
 *
 * It shares `changes` / `plan` with applyNewContractTerms rather than spreading the raw
 * extraction into an insert (which is what Add used to do, with no diff and no confirmation),
 * so both paths write exactly what the same review screen showed.
 *
 * ⚠ `vendor` is NOT defaulted to the contract's name. It used to be — `vendor: f.vendor ||
 * name.trim()` — which quietly turned the landlord's own label ("Snow — front lot") into the
 * 1099 PAYEE NAME for a vendor the AI simply hadn't found. Left null, the review says the
 * vendor wasn't found and the Edit form asks for it.
 */
export async function createServiceContractFromDocument({
  propertyId, name, changes, plan = null, extraction = null,
  contractText = null, storagePath = null, today = new Date(),
}) {
  const NUMERIC = new Set(['amount', 'escalation_pct', 'notice_days', 'renewal_term_months']);
  const fields = {};
  for (const f of changes?.fields || []) {
    fields[f.key] = NUMERIC.has(f.key) ? Number(f.to) : (f.to === '' ? null : f.to);
  }
  const created = await addServiceContract({
    property_id: propertyId,
    name: (name || '').trim() || null,
    service_type: fields.service_type ?? null,
    vendor: fields.vendor ?? null,
    vendor_email: fields.vendor_email ?? null,
    amount: fields.amount ?? null,
    frequency: fields.frequency ?? null,
    escalation_pct: fields.escalation_pct ?? null,
    start_date: fields.start_date ?? null,
    end_date: fields.end_date ?? null,
    auto_renew: fields.auto_renew ?? null,
    notice_days: fields.notice_days ?? null,
    notice_by_date: fields.notice_by_date ?? null,
    renewal_term_months: fields.renewal_term_months ?? null,
    additional_insured: fields.additional_insured ?? null,
    contract_text: contractText || null,
    storage_path: storagePath || null,
    extraction_raw: extraction || null,
    ai_confidence: extraction ? buildContractConfidence(extraction) : null,
    ai_review: extraction?.ai_review || null,
  });
  if (!created?.id) throw new Error('The contract could not be created.');
  if (storagePath) await attachDocument(storagePath, { entityType: 'service_contract', entityId: created.id });

  const steps = plan?.steps || [];
  const stepCount = steps.length ? await replaceContractEscalations(created.id, steps) : 0;

  const year = Number(localDateIso(today).slice(0, 4));
  const carried = propertyId ? await carryContractChange(propertyId, year) : { synced: false, resynced: false, leasesResynced: 0 };
  return { contract: created, feeSteps: stepCount, propertyId, year, ...carried };
}

/**
 * Commit the new contract's terms — the half that moves money, kept separate from the read
 * so nothing is written until the landlord has seen the list of what changes.
 *
 * `changes.fields` comes straight from contractChanges (src/lib/contractTerms.js), which is
 * what the dialog rendered. Applying THAT rather than re-deriving from the extraction is
 * deliberate: what he approved and what gets written are the same object.
 *
 * ⚠ NO apply_contract_tx RPC, unlike create_lease_tx (0053). A lease is created ONCE and a
 * half-created one is unrecoverable, which is what that RPC exists for. A half-applied
 * CONTRACT is fully recoverable by pressing the button again: the patch is a full column
 * set, the fee steps are delete-then-insert with no status to preserve, and both syncs write
 * only on real drift. An RPC would additionally need a demo-mock stub or the demo throws.
 * The failed state says so in words.
 *
 * ⚠ NOTHING HERE WRITES AN ESTIMATE — see carryContractChange for why that is what makes
 * George's "ACTUAL CAM and Tax, not estimated" constraint hold automatically.
 */
export async function applyNewContractTerms({
  contractId, changes, plan = null, extraction = null, envelopeId = null, today = new Date(),
}) {
  const contract = await getServiceContract(contractId);
  if (!contract) throw new Error('That contract no longer exists.');

  const NUMERIC = new Set(['amount', 'escalation_pct', 'notice_days', 'renewal_term_months']);
  const patch = {};
  for (const f of changes?.fields || []) {
    patch[f.key] = NUMERIC.has(f.key) ? Number(f.to) : (f.to === '' ? null : f.to);
  }
  // The confidence badges and the red-flag review describe a DOCUMENT. Leaving the previous
  // document's behind would caption this contract with an assessment of a file that is no
  // longer on it — so they move with the document, or are cleared if it came back without.
  if (extraction) {
    patch.extraction_raw = extraction;
    patch.ai_confidence = buildContractConfidence(extraction);
    patch.ai_review = extraction.ai_review || null;
  }
  // Through updateServiceContract, never a bare update: that is where the notice-date
  // derivation and BOTH bucket re-arms live, so a new end date re-arms the expiry email and
  // a new notice date re-arms the cancellation email.
  if (Object.keys(patch).length) await updateServiceContract(contractId, patch);

  // Built from what the contract WILL BE, not from the document in isolation — a field the
  // new document is silent on keeps the contract's own value, and the fee schedule has to be
  // dated and annualized off those same numbers.
  const built = plan || buildContractFeeSteps(extraction, contractTargets(contract, changes));
  // ⚠ ONLY when the document actually printed a schedule. Silence is not an instruction to
  // erase — the same rule the field diff follows. A renewal letter that restates the fee as
  // one flat figure and prints no table must not delete a fee schedule (hand-added steps
  // among them) that nothing in the document contradicts.
  const steps = built.steps || [];
  const stepCount = steps.length ? await replaceContractEscalations(contractId, steps) : 0;

  // When the document came back through e-signature, this is the act that clears the
  // "read the signed contract" prompt and the dashboard's signature_apply alert. Before the
  // history entry, so a failure here can't leave the log claiming an apply that then
  // silently kept nagging.
  if (envelopeId) await markEnvelopeApplied(envelopeId);

  const moved = (changes?.fields || []).map((f) => f.label).join(', ');
  await logHistoryEvent({
    property_id: contract.property_id || null, lease_id: null, type: 'contract_replaced',
    tenant_name: null,
    description: `${envelopeId ? 'Signed contract applied' : 'New contract document applied'} — ${contract.name || contract.vendor || 'service contract'}${moved ? ` (updated ${moved})` : ''}`,
    event_date: localDateIso(today),
    meta: {
      contract_id: contractId,
      envelope_id: envelopeId || null,
      fields: (changes?.fields || []).map((f) => ({ key: f.key, from: f.from ?? null, to: f.to })),
      fee_steps: stepCount, undated_steps: built.undated || 0, unusable_steps: built.unusable || 0,
    },
  });

  // The invoice does not rebuild itself (CLAUDE.md §1). Last, so one carry-through covers a
  // fee change, a term change and a new fee schedule together rather than firing per effect.
  const year = Number(localDateIso(today).slice(0, 4));
  const carried = (changes?.touchesBilling || stepCount || (built.steps || []).length) && contract.property_id
    ? await carryContractChange(contract.property_id, year)
    : { synced: false, resynced: false, leasesResynced: 0 };

  return {
    fields: (changes?.fields || []).length,
    feeSteps: stepCount,
    undatedSteps: built.undated || 0,
    unusableSteps: built.unusable || 0,
    propertyId: contract.property_id || null,
    year,
    ...carried,
  };
}

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

  // ⚠ THE INVOICE DOES NOT REBUILD ITSELF (CLAUDE.md §1) — and a rent step coming due is the
  // most routine money event this app has. Until now it moved base_rent and stopped there:
  // the Ledger and the Financials breakdown followed (they build UP from live data) while the
  // stored invoice, Outstanding and every receivable figure stayed on the pre-step rent for
  // the rest of the year. Every lease with an annual escalation hit this, every year.
  //
  // Both years are covered because a step is not always applied in the year it belongs to: a
  // historical lease entered today applies steps dated years back. resyncLeaseBilling skips a
  // closed year and no-ops when there is no invoice, so the extra call costs nothing.
  //
  // Best-effort by design — a failed resync must never leave the escalation half-applied,
  // which is the state applyDueEscalations would then skip forever.
  if (lease?.property_id) {
    const stepYear = Number(String(escalation.effective_date).slice(0, 4));
    const thisYear = Number(localDateIso().slice(0, 4));
    for (const y of [...new Set([stepYear, thisYear])]) {
      if (y > 1900) await resyncLeaseBilling(escalation.lease_id, lease.property_id, y).catch(() => null);
    }
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

// Batched for a whole property (the lender package's rollover schedule), mirroring
// listAbatementsForLeases / listEscalationsByLeases — one query instead of one per lease.
export async function listRenewalsByLeases(leaseIds) {
  if (!leaseIds || !leaseIds.length) return [];
  return rows(supabase.from('renewal_options').select('*').in('lease_id', leaseIds).order('notice_by_date'));
}

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

export const createAddendum = async (a) => {
  const row = await one(supabase.from('lease_addendums').insert({ ...a, owner_id: await ownerId() }).select().single());
  await attachDocument(a.storage_path, { entityType: 'addendum', entityId: row.id });
  return row;
};

// Patch a rider in place. Used by the rider row's "Add a file" (RiderDocs): a rider
// that was pasted in has cached text but no document, and attaching one has to write
// storage_path — that column is what the row reads to decide between "Open file" and
// "Add a file", and reading it off the already-cached rider is what keeps a lease with
// six riders from firing six document queries on load.
export const updateAddendum = (id, patch) =>
  one(supabase.from('lease_addendums').update(patch).eq('id', id).select().single());

export async function deleteAddendum(id) {
  const a = await one(supabase.from('lease_addendums').select('storage_path').eq('id', id).single()).catch(() => null);
  await deleteDocumentsFor('addendum', id, [a?.storage_path]);
  return rows(supabase.from('lease_addendums').delete().eq('id', id));
}

// One-time AI extraction of a rider/amendment (paid Claude call). Mirrors
// extractContract: accepts pasted text or an uploaded file (PDF/scan/photo/Word).
// currentTermEnd lets the extractor turn an extension stated as a LENGTH ("an additional
// five (5) years") into a real date — and cross-check the one the rider prints, which is
// sometimes impossible (Denny's says "April 31").
export async function extractAddendum({ text, storagePath, squareFootage, currentTermEnd }) {
  const { fields, full_text } = await invokeFunction('extract-addendum', {
    text,
    storage_path: storagePath,
    square_footage: squareFootage ?? null,
    current_term_end: currentTermEnd || null,
  });
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

  // Last gate before anything is written. A date that only LOOKS like one — the
  // calendar-impossible "2033-04-31" a rider can literally print — fails the Postgres
  // write and would abort this sequence part-way through, after the escalation rows had
  // already gone in. Checked up front, so a bad value costs nothing and says why.
  const extensionEnd = isoDateOrNull(changes.extensionEnd);
  if (changes.extensionEnd && !extensionEnd) {
    throw new Error(`"${changes.extensionEnd}" isn't a real date — enter the new termination date and save again.`);
  }

  // A committed extension's new base rent takes effect where the new term begins —
  // i.e. at the prior term end — so model it as the first dated step, ahead of any
  // later step-ups the rider spells out.
  const fromEnd = lease?.lease_termination_date || addendum.amendment_date || null;
  const escInputs = [...(changes.escalations || [])];
  if (extensionEnd && changes.newRent != null && fromEnd) {
    escInputs.unshift({ effective_date: fromEnd, escalation_type: 'manual', escalation_value: null, new_base_rent: Number(changes.newRent) });
  }

  // Escalations contributed by the rider (incl. the extension's opening rent above).
  // A rider that prices its rent by lease YEAR ("Year 1 … Year 3") returns undated steps
  // carrying months_from_start; they need an anchor or buildEscalations drops them. In
  // order: the operative rent's own start date when one is printed; else — only for a
  // committed EXTENSION — the term end the new period begins at; else null, i.e. the
  // drop-the-row behaviour we had before. NEVER the amendment date: that's the signing
  // date, the same trap extract-lease already warns about.
  const datedStart = escInputs.find((e) => e && e.effective_date)?.effective_date || null;
  const anchor = datedStart || (extensionEnd ? fromEnd : null);
  // Set when the rider states a CAM & tax / roof estimate, so the resync for it can run at
  // the bottom with the others — after the schedule has been rolled forward — instead of
  // firing mid-function against a rent the rider has already superseded.
  let estimateResyncYear = null;
  const escRows = buildEscalations(lease?.base_rent, escInputs, anchor);
  if (escRows.length) {
    await rows(
      supabase.from('rent_escalations').insert(
        escRows.map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled', addendum_id: addendum.id }))
      )
    );
  }

  // Extend the committed term directly — the lease's own end date is the single
  // source of truth for how long the tenant is committed.
  if (extensionEnd) {
    await updateLease(leaseId, { lease_termination_date: extensionEnd, is_active: true });
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: leaseId, type: 'term_extended', tenant_name: lease?.tenant_name || null,
      description: `Term extended to ${fmtDate(extensionEnd)}${addendum.label ? ` (${addendum.label})` : ''}`,
      event_date: addendum.amendment_date || null, meta: { addendum_id: addendum.id, new_end: extensionEnd },
    });
  }

  // A change in the SIZE of the premises — the tenant expanded into the next suite, or
  // gave space back. Written before everything below it because square_footage is the
  // numerator of the CAM / tax / roof split (v_tenant_shares:
  // square_footage / coalesce(nullif(building_sf,0), Σ leased SF)), so every figure the
  // rest of this function derives has to be computed against the new size. The stored
  // invoice does NOT rebuild itself, so the carry-through runs at the end — see there
  // for why it is sometimes property-wide.
  const newSqft = Number(changes.squareFootage);
  const priorSqft = Number(lease?.square_footage) || null;
  const sizeChanged = newSqft > 0 && newSqft !== priorSqft;
  if (sizeChanged) {
    await updateLease(leaseId, { square_footage: newSqft });
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: leaseId, type: 'premises_resized', tenant_name: lease?.tenant_name || null,
      description:
        `Premises ${priorSqft && newSqft < priorSqft ? 'reduced' : 'expanded'} to ${newSqft.toLocaleString()} SF` +
        `${priorSqft ? ` (was ${priorSqft.toLocaleString()} SF)` : ''}${addendum.label ? ` (${addendum.label})` : ''}`,
      event_date: addendum.effective_from || addendum.amendment_date || null,
      meta: { addendum_id: addendum.id, prior_sqft: priorSqft, new_sqft: newSqft },
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
    // An option this rider prices YEAR BY YEAR becomes dated, gated "pending renewal" rent
    // steps — the same treatment a lease import gives them. The window starts after the
    // term end this rider leaves behind (a rider often extends the term in the very same
    // document, so it must be the NEW end, not the old one), and the rows just inserted are
    // passed as existingSteps so the ±45-day guard can't double-book a step the rider
    // already spelled out.
    const optionTermEnd = extensionEnd || lease?.lease_termination_date || null;
    const optionSteps = buildRenewalScheduleSteps(changes.renewals, optionTermEnd, escRows, today);
    if (optionSteps.length) {
      await rows(
        supabase.from('rent_escalations').insert(
          optionSteps.map((e) => ({ ...e, lease_id: leaseId, owner_id: uid, status: 'scheduled', addendum_id: addendum.id }))
        )
      );
    }
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

  // Estimated CAM & tax the rider states ("Real Estate Taxes & CAM: $1,100.00" beside
  // the new base rent). Stored the merged way the whole app bills from — the combined
  // figure on est_cam_annual with est_tax_annual zeroed — then the year's billing is
  // resynced so the invoice AND the system-marked paid months move to base + the new
  // estimate. That is the standing rule: the estimate is what's billed all year; the
  // actual only settles it at year-end ⚖ Reconcile.
  const est = changes.estimates;
  if (est && (est.camTaxAnnual != null || est.roofAnnual != null)) {
    // Read the year through localDateIso like every other date in this file — the house
    // idiom, and the one place a timezone rule would land if the app ever grows one.
    // (It is the same calendar `today.getFullYear()` read; this is consistency, not a fix.)
    const fy = Number(localDateIso(today).slice(0, 4));
    const patch = { est_confirmed_year: fy };
    if (est.camTaxAnnual != null) {
      patch.est_cam_annual = Number(est.camTaxAnnual);
      patch.est_tax_annual = 0; // the combined convention — cam + tax reads back as the figure entered
    } else if (Number(lease?.est_tax_annual) > 0) {
      // ⚠ A ROOF-ONLY rider used to stamp est_confirmed_year while leaving a LEGACY SPLIT
      // (est_cam 9,000 + est_tax 4,000) in place — clearing the very "carried over" prompt
      // that would have driven the landlord back through the merging editor, and leaving two
      // columns that every reader sums. Merge it here instead of hiding it.
      patch.est_cam_annual = leaseCamTaxAnnual(lease);
      patch.est_tax_annual = 0;
    }
    if (est.roofAnnual != null) patch.est_roof_annual = Number(est.roofAnnual);
    // A rider states its figure FROM A DATE (0089), so the months before it keep being billed
    // — and reconciled — at the estimate the lease carried until then. Closing row first,
    // same pair as the rent boundary; without it monthlyEstimates answers the live scalar for
    // every month and the rider re-prices the year backwards.
    const estFrom = isoDateOrNull(est.effectiveDate) || isoDateOrNull(addendum.amendment_date);
    if (estFrom) {
      const priorEst = leaseCamTaxAnnual(lease);
      // `!= null`, not Number.isFinite(Number(...)) — see applyNewLeaseTerms for why the old
      // test wrote an invented roof_annual: 0 for a lease that carried no roof estimate.
      const priorRoofRaw = lease?.est_roof_annual != null ? Number(lease.est_roof_annual) : null;
      const priorRoof = Number.isFinite(priorRoofRaw) ? priorRoofRaw : null;
      const existingEst = await listLeaseEstimates(leaseId);
      const closeAt = [isoDateOrNull(lease?.lease_start), ...existingEst.map((e) => String(e.effective_date))]
        .filter(Boolean).sort().pop() || null;
      const estRows = [];
      // Written even with no prior figure (0090): a rider that PRICES an estimate onto a lease
      // that had none must not re-bill the earlier months, which were billed at the actual.
      if (closeAt && closeAt < estFrom) {
        estRows.push(priorEst != null
          ? {
            effective_date: closeAt, cam_tax_annual: priorEst, cam_tax_none: false,
            roof_annual: priorRoof,
            source: 'addendum', addendum_id: addendum.id, note: 'Estimate before this rider',
          }
          : {
            effective_date: closeAt, cam_tax_annual: null, cam_tax_none: true,
            roof_annual: priorRoof,
            source: 'addendum', addendum_id: addendum.id, note: 'No CAM & tax estimate before this rider',
          });
      }
      estRows.push({
        effective_date: estFrom,
        cam_tax_annual: patch.est_cam_annual != null ? Number(patch.est_cam_annual) : priorEst,
        cam_tax_none: patch.est_cam_annual == null && priorEst == null,
        roof_annual: patch.est_roof_annual != null ? Number(patch.est_roof_annual) : priorRoof,
        source: 'addendum', addendum_id: addendum.id, note: addendum.label || null,
      });
      await rows(
        supabase.from('lease_estimates').insert(estRows.map((r) => ({ ...r, lease_id: leaseId, owner_id: uid })))
      );
    }
    await updateLease(leaseId, patch);
    // ⚠ The resync used to fire HERE, before the schedule was rolled forward. It now runs
    // with the others at the bottom, after backfillLeaseToToday — see there for why.
    estimateResyncYear = fy;
    await logHistoryEvent({
      property_id: lease?.property_id || null, lease_id: leaseId, type: 'estimate_set', tenant_name: lease?.tenant_name || null,
      description:
        `CAM & tax estimate set${addendum.label ? ` (${addendum.label})` : ''}: ` +
        [est.camTaxAnnual != null ? `CAM & tax ${money(est.camTaxAnnual)}/yr` : null,
          est.roofAnnual != null ? `roof ${money(est.roofAnnual)}/yr` : null].filter(Boolean).join(' · '),
      event_date: est.effectiveDate || addendum.amendment_date || null,
      meta: { addendum_id: addendum.id, cam_tax_annual: est.camTaxAnnual ?? null, roof_annual: est.roofAnnual ?? null },
    });
  }

  // ⚠ ROLL THE SCHEDULE FORWARD FIRST. A rider routinely prices a rent effective on a date
  // that has already passed — an extension's opening rent sits at the PRIOR term end, which
  // is usually behind us by the time the paperwork is filed. backfillLeaseToToday is what
  // applies those steps and moves base_rent to the real current rent. Every resync below
  // therefore has to run after it, or the invoice is rebuilt from the rent the rider
  // superseded and the lease ends up reading a figure its own bill was never built from.
  const rolled = await backfillLeaseToToday(leaseId, today);

  // Carry the change through to the stored invoice — it is a frozen copy and does not
  // rebuild itself (CLAUDE.md §1). WHICH call is the load-bearing part, and it turns on
  // whether the property has a building size entered:
  //
  //   building_sf set   → the denominator is fixed, so only THIS tenant's share moved.
  //   building_sf null  → the denominator is Σ leased SF, so re-sizing one tenant
  //                       re-splits EVERY tenant on the property.
  //
  // Both skip a closed year. Deliberately last, so one settle covers an extension, a new
  // rent and a resize together rather than firing once per effect.
  //
  // ⚠ `escRows.length` is in this condition and used not to be. A rider that changes the
  // RENT — the commonest rider there is — laid its new figure into the schedule and never
  // rebuilt the bill, so the Ledger and the Financials breakdown (which build up from live
  // data) moved while the invoice, Outstanding and the receivables did not.
  const rentChanged = escRows.length > 0;
  if ((sizeChanged || rentChanged) && lease?.property_id) {
    const year = Number(localDateIso(today).slice(0, 4));
    const property = await getProperty(lease.property_id).catch(() => null);
    if (sizeChanged && !(Number(property?.building_sf) > 0)) await resyncPropertyBilling(lease.property_id, year);
    else await resyncLeaseBilling(leaseId, lease.property_id, year);
  }
  // An estimate the rider states gets the NON-skipping call even on a closed year, because
  // the landlord signed a document naming that year's figure and meant it — the same
  // exception the explicit estimate saves make. Idempotent against the resync above when
  // both ran, so the pair is safe rather than merely tolerable.
  if (estimateResyncYear != null && lease?.property_id) {
    await resyncYearBillingToEstimate(leaseId, lease.property_id, estimateResyncYear);
  }

  return rolled;
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

// ---- Expense line items (itemized CAM, property taxes and roof — all auto-summing) --
// One table, three lists (0067 `kind`, widened by 0074): 'cam' rolls into
// expense_records.cam_total, 'tax' into taxes_total, 'roof' into roof_total. Rows
// written before 0067 have no kind at all in the demo store, so the read tolerates a
// missing value rather than filtering them away.
//
// Ordered by the day the money was actually paid (0074 `paid_date`), so a year reads
// chronologically. A line with no date sorts LAST rather than first: an undated row is
// a hand-typed figure with no known day, and floating those to the top of the year
// would read as "paid in January".
const listExpenseLineItems = async (propertyId, year, kind) => {
  const all = await rows(
    supabase
      .from('cam_line_items')
      .select('*')
      .eq('property_id', propertyId)
      .eq('year', year)
      .order('created_at')
  );
  return all
    .filter((it) => (it.kind || 'cam') === kind)
    .sort((a, b) => {
      const da = a.paid_date || '';
      const db = b.paid_date || '';
      if (da !== db) return (da ? 0 : 1) - (db ? 0 : 1) || da.localeCompare(db);
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
};

export const listCamLineItems = (propertyId, year) => listExpenseLineItems(propertyId, year, 'cam');
export const listTaxLineItems = (propertyId, year) => listExpenseLineItems(propertyId, year, 'tax');
export const listRoofLineItems = (propertyId, year) => listExpenseLineItems(propertyId, year, 'roof');

// ── Expense buckets (0075) ────────────────────────────────────────────────────
// A bucket's tax category, chosen once and applied to every line that bucket holds.
// Owner-wide, NOT per-property: a bucket named once is offered on every property (the
// runtime Map in getStatementMatchContext works that way), so its category is answered
// once too. Nothing here bills anything — a category is reporting vocabulary; what a
// tenant is charged is decided by cam_line_items.billable and the pro-rata share.
export const listExpenseBuckets = () =>
  rows(supabase.from('expense_buckets').select('*').order('label'));

// Upsert by (owner, label) case-insensitively. The unique index is on
// lower(btrim(label)), so a plain insert of an existing label raises 23505 and we
// update the row already there — the same shape saveImportRule uses, and what keeps a
// bucket from holding two different categories.
export async function saveExpenseBucket({ label, category = null, billable, capital_prone }) {
  const clean = String(label || '').trim();
  if (!clean) throw new Error('A bucket needs a name.');
  if (category != null && !isValidCategory(category)) throw new Error(`Unknown category: ${category}`);

  const patch = {
    ...(category !== undefined ? { category } : {}),
    ...(billable !== undefined ? { billable } : {}),
    ...(capital_prone !== undefined ? { capital_prone } : {}),
  };
  try {
    return await one(
      supabase.from('expense_buckets')
        .insert({ label: clean, owner_id: await ownerId(), ...patch })
        .select().single()
    );
  } catch (e) {
    if (e?.code !== '23505') throw e;
    // Already exists → update it in place, preserving its id so nothing referencing
    // the bucket is disturbed.
    const existing = (await listExpenseBuckets()).find(
      (b) => bucketKey(b.label) === bucketKey(clean)
    );
    if (!existing) throw e;
    return one(
      supabase.from('expense_buckets').update(patch).eq('id', existing.id).select().single()
    );
  }
}

// Re-sum the line items and write the total into expense_records.cam_total,
// preserving taxes/roof. This is the "adds everything up" step — pure code.
// Only BILLABLE items count (billable !== false — a missing key reads billable,
// matching the DB default): "not billed to tenants" buckets are itemized for the
// landlord's records but never roll into the CAM billed back through shares.
async function syncCamTotal(propertyId, year) {
  const items = await listCamLineItems(propertyId, year);
  const camSum = items.filter((it) => it.billable !== false).reduce((s, it) => s + (Number(it.amount) || 0), 0);
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

// Re-sum an itemized list into its own column on expense_records, preserving the other
// two. The mirror of syncCamTotal for taxes ('tax' → taxes_total) and the roof
// ('roof' → roof_total, 0074) — called only from that kind's writers, so a property
// that itemizes nothing keeps whatever figure was typed by hand.
//
// Neither filters on `billable`: the billable axis exists so a landlord can track
// spending tenants shouldn't reimburse, and it is a CAM idea. A tax bill and a roof
// invoice recover through their own rules — the roof through each lease's
// roof_responsible flag, which v_property_totals already splits into recovered and
// absorbed — so a "not billed" tick here would be a second, conflicting answer to a
// question the lease has already answered.
const TOTAL_FIELD = { tax: 'taxes_total', roof: 'roof_total' };

async function syncKindTotal(propertyId, year, kind) {
  const items = await listExpenseLineItems(propertyId, year, kind);
  const sum = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const existing = await getExpenseRecord(propertyId, year);
  await upsertExpenseRecord({
    property_id: propertyId,
    year,
    taxes_total: kind === 'tax' ? sum : (existing?.taxes_total ?? 0),
    cam_total: existing?.cam_total ?? 0,
    roof_total: kind === 'roof' ? sum : (existing?.roof_total ?? 0),
  });
  return sum;
}

const syncTotalFor = (propertyId, year, kind) =>
  (kind === 'cam' ? syncCamTotal(propertyId, year) : syncKindTotal(propertyId, year, kind));

// Itemizing must never LOSE the figure that was already there. A property whose taxes
// were entered as one flat number gets that number carried into its own line the first
// time anything is itemized — otherwise the first $3,100 instalment an import finds
// would re-sum the year's taxes down to $3,100 and quietly under-bill every tenant.
// The carried line is a normal row: rename it, split it, or delete it once the real
// instalments are in.
//
// The roof carries the IDENTICAL hazard. (An earlier version of this comment said roof
// costs "bill back at 100% rather than pro-rata" — the SQL says otherwise and has since
// 0005: roof_amt is roof_total × (tenant SF ÷ building SF), the same pro-rata formula CAM
// uses, gated on each lease's roof_responsible flag. The hazard is real either way —
// re-summing an $18,000 roof down to a $500 repair under-bills every responsible tenant —
// but the figure is their pro-rata share of the difference, not the whole of it.)
// Same guard, same shape, one function.
async function carryFlatIntoItems(property_id, year, kind) {
  const existing = await listExpenseLineItems(property_id, year, kind);
  if (existing.length) return;
  const rec = await getExpenseRecord(property_id, year);
  const flat = Number(rec?.[TOTAL_FIELD[kind]]) || 0;
  if (flat <= 0) return;
  await one(
    supabase
      .from('cam_line_items')
      .insert({ property_id, year, kind, label: 'Entered by hand', amount: flat, owner_id: await ownerId() })
      .select()
      .single()
  );
}

async function addExpenseLineItem({ property_id, year, label, amount, import_id = null, billable = true, kind = 'cam', rent_pct = null, paid_date = null, asset_id = null }) {
  if (kind !== 'cam') await carryFlatIntoItems(property_id, year, kind);
  const item = await one(
    supabase
      .from('cam_line_items')
      .insert({
        property_id, year, label, amount, kind,
        billable: billable !== false,
        ...(rent_pct != null ? { rent_pct } : {}),
        ...(paid_date ? { paid_date } : {}),
        ...(import_id ? { import_id } : {}),
        ...(asset_id ? { asset_id } : {}),
        owner_id: await ownerId(),
      })
      .select()
      .single()
  );
  await syncTotalFor(property_id, year, kind);
  return item;
}

export const addCamLineItem = (fields) => addExpenseLineItem({ ...fields, kind: 'cam' });
export const addTaxLineItem = (fields) => addExpenseLineItem({ ...fields, kind: 'tax' });
export const addRoofLineItem = (fields) => addExpenseLineItem({ ...fields, kind: 'roof' });

async function deleteExpenseLineItem(id, propertyId, year, kind) {
  await rows(supabase.from('cam_line_items').delete().eq('id', id));
  return syncTotalFor(propertyId, year, kind);
}

export const deleteCamLineItem = (id, propertyId, year) => deleteExpenseLineItem(id, propertyId, year, 'cam');
export const deleteTaxLineItem = (id, propertyId, year) => deleteExpenseLineItem(id, propertyId, year, 'tax');
export const deleteRoofLineItem = (id, propertyId, year) => deleteExpenseLineItem(id, propertyId, year, 'roof');

// A management fee is priced off the rent, not typed as a figure: the row stores the
// percentage it was struck at (0067 `rent_pct`) and this keeps its dollar amount in
// step with the property's annual base rent for that year — the same self-healing
// contract rows get. Idempotent: writes only on a real drift, and never zeroes a fee
// because the rent hasn't loaded (basis 0 → left exactly as it is).
export async function syncRentPctCamItems(propertyId, year) {
  const [totals, items] = await Promise.all([
    getPropertyTotals(propertyId, year),
    listCamLineItems(propertyId, year),
  ]);
  const basis = Number(totals?.total_revenue) || 0;
  if (basis <= 0) return false;
  let changed = false;
  for (const it of items) {
    if (it.rent_pct == null) continue;
    const amount = Math.round(basis * (Number(it.rent_pct) / 100) * 100) / 100;
    if (Math.abs(amount - (Number(it.amount) || 0)) < 0.005) continue;
    await one(supabase.from('cam_line_items').update({ amount }).eq('id', it.id).select().single());
    changed = true;
  }
  if (changed) await syncCamTotal(propertyId, year);
  return changed;
}

// Auto-carry service contracts into CAM for a given fiscal year: one CAM line item per
// covering contract, at its escalated annual cost (contract_id links them). Creating,
// refreshing a drifted amount/label, and removing rows whose contract no longer covers
// the year are all handled here — so a multi-year contract needs no re-entry when a new
// fiscal year opens; viewing the year self-heals it. Idempotent: writes only on a real
// change, then re-sums the CAM total. Mirrors src/lib/contracts.js.
//
// Returns { total, changed } — `changed` says whether this call actually wrote, so the
// caller can carry a real CAM movement through to the year's invoices without doing so
// on every page visit. (syncRentPctCamItems returns the same signal as a bare boolean.)
export async function syncContractCamItems(propertyId, year) {
  const uid = await ownerId();
  const [contracts, items] = await Promise.all([
    listServiceContracts(propertyId),
    listCamLineItems(propertyId, year),
  ]);
  // The dated fee steps (0091) for EVERY contract on the property in one query, folded into
  // the same await — never a per-contract waterfall. A contract with no steps yields an empty
  // list, and contractAnnualCost then takes its pre-0091 scalar path unchanged.
  const steps = stepsByContract(await listContractEscalationsFor(contracts.map((c) => c.id)));
  const autoByContract = new Map();
  for (const it of items) if (it.contract_id) autoByContract.set(it.contract_id, it);

  const covering = contracts.filter((c) => contractCoversYear(c, year) && contractAnnualCost(c, year, steps.get(c.id)) > 0);
  const coveringIds = new Set(covering.map((c) => c.id));
  let changed = false;

  for (const c of covering) {
    const amount = contractAnnualCost(c, year, steps.get(c.id));
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

  if (changed) return { total: await syncCamTotal(propertyId, year), changed: true };
  return { total: items.reduce((s, it) => s + (Number(it.amount) || 0), 0), changed: false };
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

// ---- Rent collected so far this year, per property, in ONE round-trip -------------
// The Overview's performance panel states what FY {year} comes to ON PAPER — contract
// rent from the leases, and the expense totals entered on each Expense entry. This is the
// one figure that says how much of it has actually ARRIVED.
//
//   collected — every dollar recorded against the year's ANNUAL invoices. Deliberately
//               the same filter getYearInvoice uses (non-void, kind 'annual', a missing
//               kind reading annual), so this IS the Ledger tab's Collected column summed
//               across the property's tenants and the two can never name two figures for
//               the same property on the same day. A reconciliation true-up is therefore
//               excluded — it is real money, but it is not on that column.
//   billed    — those same invoices' totals, so a caller can say "of $X billed" and the
//               figure has something to be a share of.
//
// Read-only; no schema, no expense side. Whether a given expense has been PAID is a
// separate question with its own honesty problem (an undated line must never be given an
// invented date, and nothing may be spread evenly across the months to fill the gap) —
// deliberately not answered here.
export async function listCollectedByProperty(propertyIds, year) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const invAll = await rows(
    supabase.from('v_invoice_balances')
      .select('property_id,kind,status,total_amount,amount_paid')
      .in('property_id', ids).eq('year', year)
  );
  const out = {};
  for (const i of invAll || []) {
    if (!i?.property_id || i.status === 'void' || !isAnnualInvoice(i)) continue;
    const r = (out[i.property_id] ||= { collected: 0, billed: 0 });
    r.collected = round2(r.collected + (Number(i.amount_paid) || 0));
    r.billed = round2(r.billed + (Number(i.total_amount) || 0));
  }
  return out;
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

// `source` says where the FIGURE came from, and it is the only thing standing between a real
// cheque and the re-stamp loop below (migration 0088).
//
// The default FAILS SAFE rather than merely being convenient: a row carrying an import_id is
// bank money whatever the caller remembered to pass, so it defaults to 'import'. Only
// 'manual' has to be stated, because it is the one thing that genuinely cannot be inferred —
// a human typing a figure leaves no trace distinguishable from the app writing one.
export const recordPayment = async (pay) =>
  one(supabase.from('payments').insert({
    source: pay?.import_id ? 'import' : 'system',
    ...pay,
    owner_id: await ownerId(),
  }).select().single());

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

// When a tenant's CAM & tax estimate changes, the year's invoice AND any system-
// recorded "mark paid" months move with it — the tenant pays base + estimate all
// year; only the year-end ⚖ Reconcile uses actuals (George, 2026-07-23: "everything
// up to reconciliation uses the estimate figure"). Without this, an invoice generated
// BEFORE the estimate was typed keeps billing the old actual-based figure and the
// ledger boxes stay stale (reading $4,795 while the left rail projects $5,300).
//
// Both sides are rebuilt from the SAME per-month owed the ledger paints (build-up from
// the data: lease base + estimated-else-actual CAM/tax/roof), so a paid box equals the
// left rail to the penny. No-op unless a live annual invoice already exists — a brand-
// new lease has no invoice/payments yet, so estimate-save on creation does nothing here.
//
// Only re-records SYSTEM "mark-paid" payments (import_id == null && note == null): a
// bank-imported deposit or a manually-noted payment is a real recorded amount and is
// left untouched, so a genuine short/over payment still surfaces and trues up at
// reconcile. Returns { invoice, monthsResynced }.
export async function resyncYearBillingToEstimate(leaseId, propertyId, year) {
  const existing = await getYearInvoice(leaseId, year);
  if (!existing) return { invoice: null, monthsResynced: 0 };

  const [share, abatements, escalations, adjustments, estimates] = await Promise.all([
    getTenantShare(leaseId, year),
    listAbatements(leaseId),
    listEscalations(leaseId),
    listAdjustments({ leaseId, year }),
    listLeaseEstimates(leaseId),
  ]);
  if (!share) return { invoice: existing, monthsResynced: 0 };

  const grossBase = Number(share.base_rent || 0);
  const billed = billedComponents(share); // estimate-preferred per component
  // A GROSS lease's expenses are already inside the flat rent, so nothing is added on
  // top: the month owes the flat figure and the components below are carved out of it.
  //
  // ⚠ NOTE WHAT IS DELIBERATELY NOT PASSED HERE: `adjustments`. This schedule is the
  // SCHEDULED owed, and the re-stamp loop at the bottom of this function rewrites any
  // all-system-marked month whose recorded total differs from it. Feed it the ADJUSTED
  // owed and a +$400 charge would DELETE the tenant's $5,000 payment and write $5,400 —
  // asserting money that never arrived, and pushing Collected up by the charge. An
  // estimate re-prices money the tenant was always going to pay; a charge is new money
  // that hasn't. Σ adjustments reaches the invoice TOTAL below and nowhere else.
  // The estimate month by month (0089), so a figure that changed part way through the year
  // prices the earlier months at what they were actually billed rather than re-pricing them.
  const estMonths = estimateMonths(estimates, share, year);
  const otherByMonth = otherMonthsFor(estimates, share, year, billed);
  const { schedule } = buildLeaseSchedule({
    year, grossBase, otherAnnual: billed.gross ? 0 : billed.cam + billed.tax + billed.roof,
    otherByMonth, abatements, escalations, leaseStart: share.lease_start,
  });
  const adjTotal = round2((adjustments || []).reduce((s, a) => s + (Number(a.amount) || 0), 0));

  // Regenerate the year invoice in place with the SAME term-aware proration
  // draft-invoice uses (a mid-year lease bills only the months it covers), so a
  // resync'd invoice is identical to the manual flow AND its total equals the sum of
  // the monthly boxes below. Preserve the existing issue/due dates + status so
  // refreshing figures never wipes them. Full-year lease → ratio 1 → full figures.
  const bases = monthlyBases(escalations, grossBase, year);
  let inTerm = 0;
  let proratedBaseGross = 0;
  let proratedAbatement = 0;
  // Σ of the in-term months' CAM & tax / roof. With no dated ledger every month carries the
  // same annual rate and these land on exactly `billed.cam * ratio` — the old arithmetic, to
  // the cent. With one, the invoice's stored annual becomes what was ACTUALLY billed across
  // the year instead of today's figure applied backwards over months already collected.
  let proratedCamTax = 0;
  let proratedRoof = 0;
  for (let m = 1; m <= 12; m++) {
    if (schedule[m]?.outsideTerm) continue;
    inTerm += 1;
    proratedBaseGross += (bases[m - 1] != null ? Number(bases[m - 1]) : grossBase) / 12;
    proratedAbatement += Number(schedule[m]?.credit) || 0;
    proratedCamTax += (estMonths ? Number(estMonths.camTax[m - 1]) || 0 : billed.cam + billed.tax) / 12;
    proratedRoof += (estMonths ? Number(estMonths.roof[m - 1]) || 0 : billed.roof) / 12;
  }
  const ratio = inTerm / 12;
  // The cam/tax split stays as billedComponents reports it whenever nothing was dated (a
  // legacy lease with the two entered separately keeps them separate); once the ledger has
  // moved the figure, the combined amount rides on cam with tax zeroed — the storage
  // convention every reader of these columns already assumes.
  const segmented = estMonths && Math.abs(round2(proratedCamTax) - round2((billed.cam + billed.tax) * ratio)) > 0.005;
  const invCam = segmented ? round2(proratedCamTax) : round2(billed.cam * ratio);
  const invTax = segmented ? 0 : round2(billed.tax * ratio);
  const invRoof = estMonths ? round2(proratedRoof) : round2(billed.roof * ratio);
  // Gross: the components come OUT of the prorated flat rent, so the stored figures
  // still sum to the same total the schedule owes (the ledger reads them back to split
  // each month). Net: base is the rent and the components ride on top, as before.
  const invBase = billed.gross
    ? round2(proratedBaseGross - invCam - invTax - invRoof)
    : round2(proratedBaseGross);
  const invAbate = round2(proratedAbatement);
  // Σ per-month charges/credits rides on the TOTAL only — the four component columns
  // keep describing the lease's own figures, and the month shape comes from the rows.
  // (buildLeaseSchedule's reconcile-to-a-bill mode subtracts Σadj back out before
  // scaling, so the two stay consistent.)
  const total = Math.max(0, round2(invBase + invCam + invTax + invRoof - invAbate + adjTotal));
  const { invoice } = await upsertYearInvoice({
    lease_id: leaseId,
    property_id: propertyId,
    year: Number(year),
    issue_date: existing.issue_date || null,
    due_date: existing.due_date || null,
    base_rent_annual: invBase,
    cam_annual: invCam,
    tax_annual: invTax,
    roof_annual: invRoof,
    abatement_annual: invAbate,
    total_amount: total,
  });

  // Re-stamp system "mark-paid" months at the new per-month owed. A month whose
  // payments are ALL system marks and whose recorded total differs from the
  // schedule's owed by > 1¢ is rebuilt: delete those rows, then (when owed > 0)
  // record ONE payment at owed, keeping the earliest prior paid_date so the history
  // isn't rewritten. (This also collapses any stray same-month top-ups into one clean
  // payment.)
  const payments = await listPayments(invoice.id);
  const byMonth = {};
  for (const p of payments) {
    const m = Number(p.period_month);
    if (!m) continue; // untagged (annual/lump) money is left to the pool allocator
    (byMonth[m] ||= []).push(p);
  }
  let monthsResynced = 0;
  for (const m of Object.keys(byMonth).map(Number)) {
    const group = byMonth[m];
    // ⚠ ONLY a row the APP wrote off the schedule may be re-priced. This used to be inferred
    // from `import_id == null && !note` — "no evidence anyone touched it" — which classified
    // every hand-recorded cheque as something the app made up, because neither the Ledger
    // click nor the month panel's "Record $X received" writes a note. The row was deleted and
    // replaced with money that never arrived, and no bank statement could ever reconcile
    // against it again. Provenance is now stored (0088), and anything that is not explicitly
    // 'system' is left alone — an unknown value fails SAFE, toward protecting the money.
    const allSystem = group.every((p) => p.source === 'system');
    if (!allSystem) continue;
    const owed = round2(Number(schedule[m]?.owed) || 0);
    const recorded = round2(group.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    if (Math.abs(recorded - owed) <= 0.01) continue; // already at the estimate-based owed
    // ⚠ A month that now owes NOTHING must not have its record deleted. The rewrite below
    // deletes first and re-records only `if (owed > 0)`, so a month that fell out of term —
    // which is what happens the instant a replacement lease moves lease_start forward, via
    // occupancyStart → monthlyScheduleForYear's outsideTerm — used to lose its payment rows
    // outright, with nothing written back. Money the landlord had recorded as received
    // simply vanished from the ledger and from Collected. A month reading "paid, nothing
    // owed" is visible and reversible; a deleted payment is neither.
    if (!(owed > 0)) continue;
    const paidDate = group.map((p) => p.paid_date).filter(Boolean).sort()[0] || paymentIsoToday();
    await Promise.all(group.map((p) => deletePayment(p.id)));
    if (owed > 0) {
      await recordPayment({
        invoice_id: invoice.id,
        lease_id: leaseId,
        amount: owed,
        paid_date: paidDate,
        method: 'check',
        note: null,
        period_month: m,
        source: 'system', // it replaces a system mark and stays one — re-pricable next time
      });
    }
    monthsResynced += 1;
  }

  // Leave a trace. Every other money action writes a history_events row — estimate_set,
  // cam_reconciled, lease_adjusted, statement_imported — and this one, which can move a bill
  // the tenant has already been sent AND rewrite the months marked paid against it, wrote
  // nothing at all. Reading the property History, a rewritten invoice was indistinguishable
  // from one nobody had touched. Only logged when a figure actually moved, so the routine
  // no-op resyncs (which fire on almost every save) don't bury the log.
  const priorTotal = round2(Number(existing.total_amount) || 0);
  if (Math.abs(round2(total - priorTotal)) > 0.005 || monthsResynced > 0) {
    await logHistoryEvent({
      property_id: propertyId || null, lease_id: leaseId, type: 'billing_rebuilt',
      tenant_name: share.tenant_name || null,
      description:
        `Bill for ${year} rebuilt: ${money(priorTotal)} → ${money(total)}` +
        (monthsResynced ? ` · ${monthsResynced} recorded month${monthsResynced === 1 ? '' : 's'} re-stamped` : ''),
      event_date: localDateIso(),
      meta: { year: Number(year), from: priorTotal, to: total, months_resynced: monthsResynced },
    });
  }
  return { invoice, monthsResynced };
}

// A year is "closed" once it has a financial_snapshots row — what closeYear writes
// and reopenYear removes. The snapshot itself is immutable either way, so this isn't
// about protecting History; it's about not rewriting a bill that was already sent.
export async function isYearClosed(propertyId, year) {
  if (!propertyId || !year) return false;
  const snaps = await listSnapshots(propertyId).catch(() => []);
  return (snaps || []).some((s) => Number(s.year) === Number(year));
}

// ---- Automatic follow-through -----------------------------------------------
// The two functions below are for when a figure that FEEDS billing moved as a side
// effect of some other edit — square footage, roof responsibility, a rent step, an
// abatement, the building size, a CAM or tax total. The Financials breakdown and the
// Ledger grid build UP from live data so they follow on their own; the stored invoice
// is a frozen copy and does not, which is how it goes quietly stale.
//
// They differ from resyncYearBillingToEstimate (which they call) in ONE way: a year
// the landlord has CLOSED is left exactly as it was. The distinction that makes that
// right: there, the landlord typed a billed figure on that year's screen and meant it;
// here they changed something else entirely, and a bill already sent for a closed year
// should not move underneath them.
export async function resyncLeaseBilling(leaseId, propertyId, year) {
  if (!leaseId || !propertyId || !year) return { invoice: null, monthsResynced: 0, skipped: 'incomplete' };
  if (await isYearClosed(propertyId, year)) return { invoice: null, monthsResynced: 0, skipped: 'closed' };
  return resyncYearBillingToEstimate(leaseId, propertyId, year);
}

// A PROPERTY-wide figure moved (building size — the share denominator; a CAM, tax or
// roof total — the numerator), so every tenant's share re-splits and every live annual
// invoice on the property has to follow. Fans out over the invoices that actually
// exist, reusing the per-lease resync so there stays exactly one implementation of the
// math. Returns { leases, monthsResynced } — how many invoices moved, and how many
// system-marked months were re-stamped across them.
export async function resyncPropertyBilling(propertyId, year) {
  if (!propertyId || !year) return { leases: 0, monthsResynced: 0, skipped: 'incomplete' };
  if (await isYearClosed(propertyId, year)) return { leases: 0, monthsResynced: 0, skipped: 'closed' };
  const invoices = await rows(
    supabase
      .from('invoices')
      .select('id, lease_id, year, kind, status')
      .eq('property_id', propertyId)
      .eq('year', Number(year))
      .neq('status', 'void')
  );
  const leaseIds = [...new Set((invoices || []).filter(isAnnualInvoice).map((i) => i.lease_id).filter(Boolean))];
  const results = await Promise.all(
    leaseIds.map((id) => resyncYearBillingToEstimate(id, propertyId, year).catch(() => null))
  );
  return {
    leases: results.filter((r) => r?.invoice).length,
    monthsResynced: results.reduce((s, r) => s + (r?.monthsResynced || 0), 0),
  };
}

// buildLeaseSchedule (the term-aware monthly schedule builder) lives in
// ./leaseSchedule so the ledger math (ledger.js) can reuse the exact same
// per-month owed shape. Imported at the top of this file.

// ---- Per-month charges and credits — the tenant sub-ledger (0082) -----------
// A month's owed is DERIVED, never stored, so until now a one-off correction (the CAM
// really was different that month, a late fee, a concession) had nowhere to land. A
// lease_adjustments row is a SIGNED dollar figure on one lease-month: + charges the
// tenant, − credits them. The pure vocabulary + arithmetic live in ./adjustments.
//
// ⚠ THE RULE THE WHOLE FEATURE RESTS ON: an adjustment changes what is OWED. It never
// changes what was RECEIVED, and it never counts itself as covered. Both halves are
// enforced where they can actually be broken — see resyncYearBillingToEstimate below
// (which deliberately builds its schedule WITHOUT adjustments) and allocatePayments.
export async function listAdjustments({ leaseId = null, propertyId = null, year = null } = {}) {
  let q = supabase.from('lease_adjustments').select('*');
  if (leaseId) q = q.eq('lease_id', leaseId);
  if (propertyId) q = q.eq('property_id', propertyId);
  if (year != null) q = q.eq('year', Number(year));
  return rows(q.order('created_at'));
}

// One query for a whole property's tenants (the roll / alert paths), grouped by lease.
export async function listAdjustmentsByLeases(leaseIds, year) {
  const ids = [...new Set((leaseIds || []).filter(Boolean))];
  const byLease = Object.fromEntries(ids.map((id) => [id, []]));
  if (ids.length === 0) return byLease;
  let q = supabase.from('lease_adjustments').select('*').in('lease_id', ids);
  if (year != null) q = q.eq('year', Number(year));
  const all = await rows(q.order('created_at'));
  for (const a of all || []) (byLease[a.lease_id] ||= []).push(a);
  return byLease;
}

// The scheduled (pre-adjustment) owed for one lease-year — what a new adjustment is
// validated against, and what the month panel shows beside it.
async function scheduledOwedFor(leaseId, year) {
  const [abatements, share, escalations, estimates] = await Promise.all([
    listAbatements(leaseId),
    getTenantShare(leaseId, year),
    listEscalations(leaseId),
    listLeaseEstimates(leaseId),
  ]);
  const grossBase = share ? Number(share.base_rent || 0) : 0;
  const billed = share ? billedComponents(share) : { cam: 0, tax: 0, roof: 0, gross: false };
  const { schedule } = buildLeaseSchedule({
    year, grossBase, otherAnnual: billed.gross ? 0 : billed.cam + billed.tax + billed.roof,
    otherByMonth: otherMonthsFor(estimates, share, year, billed),
    abatements, escalations, leaseStart: share?.lease_start,
  });
  return { schedule, share, billed };
}

// Post a charge or a credit on one month, then run the full §1 carry-through so every
// screen that reads a billed figure moves with it (the caller adds settleBillingChange).
// Returns { row } or { refused, reason, message } — refusals are surfaced, never silent.
export async function addAdjustment({ leaseId, propertyId, year, month, kind, amount, memo = null }) {
  const m = Number(month);
  const y = Number(year);
  const amt = round2(Number(amount) || 0);
  if (!leaseId || !propertyId || !(y > 0) || !(m >= 1 && m <= 12)) {
    return { refused: true, reason: 'incomplete', message: 'Pick a month and an amount.' };
  }
  if (!(Math.abs(amt) > 0)) {
    return { refused: true, reason: 'zero', message: 'Enter an amount.' };
  }
  // A closed year is a bill already sent — the same refusal resyncLeaseBilling makes.
  if (await isYearClosed(propertyId, y)) {
    return { refused: true, reason: 'closed', message: `FY ${y} is closed. Reopen it first, or record the correction in an open year.` };
  }
  const { schedule, billed, share } = await scheduledOwedFor(leaseId, y);
  // ⚠ A GROSS lease has no separate CAM to correct: the flat rent already CONTAINS taxes
  // & CAM and the tenant's share is carved OUT of it, never billed on top (0073). Adding
  // a CAM correction there re-adds on top of a rent that already includes it — the exact
  // hole 0073 exists to close. Matches reconcileCamTax's own refusal.
  if (!adjustmentAllowed(kind, { gross: !!billed.gross })) {
    return {
      refused: true,
      reason: 'gross',
      message: 'This is a gross lease — taxes & CAM are already inside the flat rent, so there is no separate CAM to correct. Use a base rent correction or a credit instead.',
    };
  }
  // Keep the month non-negative. A credit larger than the month's bill would make owed
  // negative, which reads as "unbilled" everywhere downstream and would silently drop
  // the excess out of the year total.
  const existing = await listAdjustments({ leaseId, year: y });
  const already = monthlyAdjustments(existing)[m - 1];
  const scheduled = round2(Number(schedule?.[m]?.owed) || 0);
  const after = round2(scheduled + already + amt);
  if (after < -0.005) {
    return {
      refused: true,
      reason: 'negative',
      message: `That credit is larger than ${monthName(m)}'s bill (${round2(scheduled + already)}). Credit no more than the month owes, or split it across months.`,
    };
  }
  const row = await one(
    supabase.from('lease_adjustments').insert({
      owner_id: await ownerId(),
      lease_id: leaseId,
      property_id: propertyId,
      year: y,
      month: m,
      kind,
      amount: amt,
      memo: memo || null,
    }).select().single()
  );
  await resyncLeaseBilling(leaseId, propertyId, y).catch(() => null);
  await logHistoryEvent({
    property_id: propertyId,
    lease_id: leaseId,
    type: 'lease_adjusted',
    tenant_name: share?.tenant_name || null,
    description: `${adjustmentKindInfo(kind).label} — ${monthName(m)} ${y}: ${amt < 0 ? '−' : '+'}$${Math.abs(amt).toFixed(2)}${memo ? ` (${memo})` : ''}`,
    meta: { month: m, kind, amount: amt },
  });
  return { row };
}

export async function deleteAdjustment(id) {
  const row = await one(supabase.from('lease_adjustments').select('*').eq('id', id).single()).catch(() => null);
  await rows(supabase.from('lease_adjustments').delete().eq('id', id));
  if (row?.lease_id && row?.property_id && row?.year) {
    await resyncLeaseBilling(row.lease_id, row.property_id, Number(row.year)).catch(() => null);
  }
  return row;
}

// Everything the ledger grid needs for one lease + year in one call: the year's
// invoice (or null), the expected annual/monthly amount, which months are paid
// (period_month -> { amount, ids, paid_date, method }), and the raw payments so
// the coverage allocator can pool untagged (lump/partial) money too.
export async function getMonthlyRent(leaseId, year) {
  const [invoice, abatements, share, escalations, adjustments, estimates] = await Promise.all([
    getYearInvoice(leaseId, year),
    listAbatements(leaseId),
    getTenantShare(leaseId, year),
    listEscalations(leaseId),
    listAdjustments({ leaseId, year }),
    listLeaseEstimates(leaseId),
  ]);
  // The schedule builds UP from the data (George, 2026-07-21): base rent straight from the
  // lease (constant, escalation-aware) + estimated-else-actual CAM/tax/roof. We deliberately do
  // NOT scale to the invoice total — the invoice is a downstream OUTPUT of this same data, not a
  // source the ledger reads back from. So base always shows the lease's real per-month rent, never
  // a residual squeezed to fit a stale invoice. The tenant-share view is the source of truth.
  let grossBase = 0;
  let billed = { cam: 0, tax: 0, roof: 0 };
  if (share) {
    grossBase = Number(share.base_rent || 0);
    billed = billedComponents(share);
  } else if (invoice) {
    grossBase = Number(invoice.base_rent_annual || 0);
    billed = { cam: Number(invoice.cam_annual || 0), tax: Number(invoice.tax_annual || 0), roof: Number(invoice.roof_annual || 0) };
  }
  // Gross lease: the flat rent already contains CAM/tax/roof, so they add nothing on
  // top — the month owes the flat figure and the components are carved out of it.
  // (The invoice-fallback branch above needs no such test: its stored figures were
  // already carved when the invoice was written, so they still sum to the flat total.)
  const other = billed.gross ? 0 : billed.cam + billed.tax + billed.roof;
  // Null on the invoice-fallback branch above (no share): those stored figures were already
  // segmented when the invoice was written, and segmenting them again would double-apply it.
  const estMonths = estimateMonths(estimates, share, year);
  const { schedule, annual, owedMonths, occupancyStartIso: occ, factor, adjustments: adjArr } = buildLeaseSchedule({
    year, grossBase, otherAnnual: other, otherByMonth: otherMonthsFor(estimates, share, year, billed),
    abatements, escalations, leaseStart: share?.lease_start, adjustments,
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
  return { invoice, annual, monthly: owedMonths ? annual / owedMonths : 0, owedMonths, byMonth, payments, schedule, factor, adjustments: adjArr, adjustmentRows: adjustments || [], occupancyStartIso: occ, hasAbatement: (abatements || []).length > 0 };
}

// Mark month (1-12) paid: ensure the year's invoice exists, then record a payment
// tagged with that month. amount defaults to the monthly share (invoice total / 12).
export async function markMonthPaid(leaseId, propertyId, year, month, opts = {}) {
  const m = Number(month);
  const hasAmount = opts.amount != null && opts.amount !== '';
  // When no explicit amount is given we must rebuild the term-aware schedule to find the
  // month's owed — start that in PARALLEL with ensuring the invoice. The Ledger grid passes
  // an amount for the common open→mark click, so that schedule fetch is skipped entirely there.
  const [invoice, schedInputs] = await Promise.all([
    ensureInvoice(leaseId, propertyId, year),
    hasAmount
      ? Promise.resolve(null)
      : Promise.all([listAbatements(leaseId), getTenantShare(leaseId, year), listEscalations(leaseId), listAdjustments({ leaseId, year }), listLeaseEstimates(leaseId)]),
  ]);
  const m1 = m;
  // Already marked — from this screen, the property ledger, or another device.
  // Recording again would double-count the month, so this is an idempotent no-op —
  // UNLESS opts.additional is set (a deliberate top-up: the tenant later paid the
  // difference on a month that settled short), which records a SECOND same-month
  // payment that the allocation sums with the first.
  const existingPayments = await listPayments(invoice.id);
  if (!opts.additional && existingPayments.some((p) => Number(p.period_month) === m1)) return invoice;
  let amount;
  if (hasAmount) {
    amount = Number(opts.amount);
  } else {
    // Default to that month's expected owed from the TERM-AWARE schedule, built UP from the data:
    // the gross lease base (prorated for a mid-year start + blended for mid-year steps + net of any
    // base-rent abatement) + estimated-else-actual CAM/tax/roof — NOT scaled to the invoice, and
    // NOT a flat total/12 (which over-bills free months and mis-bills a partial-year lease).
    const [abatements, share, escalations, adjustments, estimates] = schedInputs;
    const grossBase = share ? Number(share.base_rent || 0) : Number(invoice.base_rent_annual || 0);
    const billed = share ? billedComponents(share) : { cam: Number(invoice.cam_annual || 0), tax: Number(invoice.tax_annual || 0), roof: Number(invoice.roof_annual || 0) };
    const { schedule: sched } = buildLeaseSchedule({
      // Gross: expenses are inside the flat rent, so nothing rides on top (the invoice
      // fallback is already carved, hence no test on that branch). Adjustments DO count
      // here — marking a month paid with no amount means "record what this month owes",
      // and a charge posted on it is part of what it owes.
      year, grossBase, otherAnnual: billed.gross ? 0 : billed.cam + billed.tax + billed.roof,
      otherByMonth: otherMonthsFor(estimates, share, year, billed),
      abatements, escalations, leaseStart: share?.lease_start, adjustments,
    });
    amount = sched[m]?.owed ?? (Number(invoice.total_amount || 0) / 12);
  }
  // Nothing due this month (before the tenancy began, or a fully-free base with no other
  // charges) — don't record a $0 payment; the month shows "—" or "Free". An explicit
  // amount override still records.
  if (!(amount > 0) && !hasAmount) return invoice;
  await recordPayment({
    invoice_id: invoice.id,
    lease_id: leaseId,
    amount,
    paid_date: opts.paid_date || paymentIsoToday(),
    method: opts.method || 'check',
    note: opts.note || null,
    period_month: m,
    // Ticking a month's box is the app pricing it off the schedule — a 'system' mark, and it
    // follows the schedule if a billed figure later moves. A caller that is recording money
    // a HUMAN says actually arrived (the month panel's "Record $X received") passes
    // source: 'manual', and that figure is then never re-priced by anything (0088).
    source: opts.source || 'system',
  });
  return invoice;
}

// Undo a month: delete every payment tagged with that month on the year's invoice.
export async function unmarkMonthPaid(leaseId, year, month) {
  const invoice = await getYearInvoice(leaseId, year);
  if (!invoice) return;
  const payments = await listPayments(invoice.id);
  await Promise.all(
    payments.filter((x) => Number(x.period_month) === Number(month)).map((p) => deletePayment(p.id))
  );
}

// Bulk across MONTHS: mark every listed month paid for every tenant that still owes it,
// for `year`. Powers the Ledger's "mark everyone paid through {month}" catch-up (and the
// single-month "✓ all" via markMonthPaidAllTenants below) in ONE round-trip instead of a
// serial loop of full-roll reads. Skips a (tenant, month) that's already tagged or that a
// pooled lump already covers; a partial month is topped up by its gap only. Returns
// { paid: rows written, tenants: distinct leases touched, total: tenants on the property }.
//
// Fast path: one batched read (getPropertyMonthlyRoll); each tenant's ONE allocation
// decides every month (the gaps are computed against the SAME allocation, so an untagged
// partial completes exactly one month and the year still settles to the cent); invoices
// that don't exist yet are drafted ONCE per lease in PARALLEL; then all payments land in
// ONE insert.
export async function markMonthsPaidAllTenants(propertyId, year, months, opts = {}) {
  const monthList = (Array.isArray(months) ? months : [months]).map(Number).filter((m) => m >= 1 && m <= 12);
  const roll = await getPropertyMonthlyRoll(propertyId, year);
  const targets = [];
  const leasesTouched = new Set();
  for (const r of roll) {
    const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
    for (const m of monthList) {
      if (r.byMonth[m] || !((Number(r.schedule?.[m]?.owed) || 0) > 0)) continue;
      const gap = Math.round((alloc.owed[m - 1] - alloc.coverage[m - 1]) * 100) / 100;
      if (!(gap > 0.05)) continue;
      targets.push({ r, m, amount: gap });
      leasesTouched.add(r.lease_id);
    }
  }
  if (targets.length === 0) return { paid: 0, tenants: 0, total: roll.length };

  // Draft any missing year-invoices ONCE per lease, concurrently (the only per-tenant remote cost).
  const invoiceByLease = {};
  for (const r of roll) if (r.invoice_id) invoiceByLease[r.lease_id] = r.invoice_id;
  const needInvoice = [...leasesTouched].filter((id) => !invoiceByLease[id]);
  await Promise.all(needInvoice.map(async (id) => {
    invoiceByLease[id] = (await ensureInvoice(id, propertyId, year)).id;
  }));

  const owner = await ownerId();
  const paidDate = opts.paid_date || paymentIsoToday();
  const payRows = targets.map(({ r, m, amount }) => ({
    invoice_id: invoiceByLease[r.lease_id],
    lease_id: r.lease_id,
    amount,
    paid_date: paidDate,
    method: opts.method || 'check',
    note: opts.note || null,
    period_month: m,
    owner_id: owner,
    // ⚠ STATED, never left to the column default (0088). The amount above is `gap` — the
    // app pricing the month off the schedule — so it is a 'system' mark, exactly like
    // markMonthPaid's tick, and it must follow a billed figure that later moves.
    //
    // This insert bypasses recordPayment, so it used to write no source at all. Postgres
    // filled 'system' from the default while the demo mock (which applies no defaults) left
    // it undefined — and `group.every(p => p.source === 'system')` reads undefined as NOT
    // system. The two behaved oppositely, and every test asserting the 0088 rule ran only
    // against the demo side.
    source: opts.source || 'system',
  }));
  await rows(supabase.from('payments').insert(payRows));
  return { paid: payRows.length, tenants: leasesTouched.size, total: roll.length };
}

// Single-month "✓ all" — thin wrapper over the plural bulk. Keeps the historical
// { paid, skipped, total } shape (paid = tenants collected this month).
export async function markMonthPaidAllTenants(propertyId, year, month, opts = {}) {
  const res = await markMonthsPaidAllTenants(propertyId, year, [month], opts);
  return { paid: res.paid, skipped: res.total - res.tenants, total: res.total };
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
  const [abByLease, escByLease, adjByLease, estByLease] = await Promise.all([
    listAbatementsForLeases(leaseIds),
    listEscalationsByLeases(leaseIds),
    listAdjustmentsByLeases(leaseIds, year),
    listLeaseEstimatesByLeases(leaseIds),
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
    // The schedule builds UP from the data (George, 2026-07-21): base rent straight from the lease
    // (constant, escalation-aware) + estimated-else-actual CAM/tax/roof. NOT scaled to the invoice
    // total — the invoice is a downstream output of this same data, not a source. So the base line
    // always reads the lease's real per-month rent (e.g. $2,395.42), never a residual squeezed to a
    // stale invoice. Always read the gross from the tenant-share row so a preview (no invoice yet)
    // matches what the invoice will bill.
    const grossBase = Number(s.base_rent || 0);
    const billed = billedComponents(s);
    // Gross lease: CAM/tax/roof are already inside the flat rent, so the month owes the
    // flat figure and componentizeSchedule carves the split out of it.
    const other = billed.gross ? 0 : billed.cam + billed.tax + billed.roof;
    const abatements = abByLease[s.lease_id] || [];
    const escalations = escByLease[s.lease_id] || [];
    const adjustmentRows = adjByLease[s.lease_id] || [];
    // The estimate month by month (0089). It reaches componentizeSchedule via camTaxByMonth /
    // roofByMonth on the returned row — and it MUST, because base is a remainder there: split
    // a segmented month with a flat annual and the difference prints as changed BASE RENT.
    const estMonths = estimateMonths(estByLease[s.lease_id] || [], s, year);
    const { schedule, annual, owedMonths, occupancyStartIso: occ, factor, adjustments: adjArr } = buildLeaseSchedule({
      year, grossBase, otherAnnual: other,
      otherByMonth: otherMonthsFor(estByLease[s.lease_id] || [], s, year, billed),
      abatements, escalations, leaseStart: s.lease_start, adjustments: adjustmentRows,
    });
    const payments = inv ? (paymentsByInvoice[inv.id] || []) : [];
    const byMonth = {};
    for (const p of payments) {
      const m = Number(p.period_month);
      if (!m) continue;
      (byMonth[m] ||= { amount: 0 }).amount += Number(p.amount) || 0;
    }
    return { lease_id: s.lease_id, invoice_id: inv ? inv.id : null, tenant_name: s.tenant_name, annual, monthly: owedMonths ? annual / owedMonths : 0, owedMonths, byMonth, payments, schedule, factor, adjustments: adjArr, adjustmentRows, camTaxAnnual: billed.camTax ?? (billed.cam + billed.tax), roofAnnual: billed.roof, camTaxByMonth: estMonths?.camTax || null, roofByMonth: estMonths?.roof || null, invoiceTotal: inv ? Number(inv.total_amount) : null, drift: invoiceDrift(inv, annual), occupancyStartIso: occ, hasAbatement: abatements.length > 0, balance: inv ? Number(inv.balance) : null, is_active: s.is_active, lease_termination_date: s.lease_termination_date, square_footage: s.square_footage, base_rent: Number(s.base_rent || 0), premises_address: s.premises_address || null, anyEstimate: billed.anyEstimate, gross: billed.gross };
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
  // A gross lease never bills an estimate, so there is no estimate-vs-actual to settle
  // (the UI hides ⚖ Reconcile for one; this is the belt-and-braces refusal).
  if (share.lease_type === 'gross') {
    throw new Error('Gross lease — CAM & taxes are included in the rent; there is nothing to reconcile.');
  }

  // Settle against WHAT WAS BILLED — the same figure the Finances "Estimated" column and
  // live Difference show — so the reconciliation the landlord confirms is exactly the one on
  // screen. Any CAM & tax CORRECTIONS posted on the Ledger (0082) are part of what was
  // billed, so they ride on the estimate side — otherwise this would true up as though they
  // hadn't been, charging them twice.
  //
  // ⚠ 0089 — "what was billed" is now month by month. It used to be today's annual estimate
  // applied to all twelve months, so an estimate raised in August settled the whole year at
  // the new figure and the true-up was wrong by (Δestimate × the months billed at the old
  // one) — refunding money that was never collected. George: *"the previous months aren't
  // affected and shouldn't be reconciled at the new figures because they would be part of
  // the old lease."*
  const [adjustments, estimates] = await Promise.all([
    listAdjustments({ leaseId, year }),
    listLeaseEstimates(leaseId),
  ]);
  const fig = reconcileFigures({ share, adjustments, estimates, year });

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
export async function fetchAlertData({ leadDays = null, ledgerOn = true, esignOn = true } = {}) {
  // ⚠ THIS DESTRUCTURING IS POSITIONAL. A new read goes at the END of BOTH the array and
  // the binding, or every query after the insertion point is bound to the wrong result.
  const [leasesR, escR, renR, propR, insR, conR, abaR, insReqR, corpR, arR, conEscR] = await Promise.all([
    supabase.from('leases').select('id,tenant_name,property_id,lease_start,lease_termination_date,no_renewal_option,is_active,base_rent,notify_lease_end_days'),
    supabase.from('rent_escalations').select('lease_id,effective_date,status,new_base_rent'),
    supabase.from('renewal_options').select('id,lease_id,notice_by_date,status'),
    supabase.from('properties').select('id,name,corporation_id'),
    // created_at/updated_at let buildAlerts tell whether a tenant answered an insurance
    // request (a policy saved AFTER the request) for the chase-up alert.
    supabase.from('insurance_policies').select('id,party,property_id,lease_id,insurer,expiry_date,created_at,updated_at').is('archived_at', null),
    // Widened for the renewal / notice alerts (0091). notice_by_date is the deadline that
    // costs money; auto_renew and renewal_term_months are what the alert has to SAY.
    supabase.from('service_contracts').select('id,name,vendor,vendor_email,end_date,property_id,amount,frequency,auto_renew,notice_days,notice_by_date,renewal_term_months'),
    // Free-rent-ending alerts: abatement windows about to close.
    supabase.from('rent_abatements').select('lease_id,start_date,end_date,kind,value'),
    // Insurance chase-up: when each tenant was last asked for a certificate.
    supabase.from('history_events').select('lease_id,event_date,created_at').eq('type', 'insurance_requested'),
    // Annual-report alerts need the corporation name for the alert title/click target.
    supabase.from('corporations').select('id,name'),
    supabase.from('annual_reports').select('corporation_id,due_date,last_filed_date'),
    // APPENDED, never inserted — see the positional-destructuring note above. The dated fee
    // steps behind the "fee step coming due" alert.
    supabase.from('contract_escalations').select('contract_id,effective_date,new_amount'),
  ]);
  const leases = leasesR.data || [];
  const escalations = escR.data || [];
  const abatements = abaR.data || [];
  return {
    leases,
    escalations,
    renewals: renR.data || [],
    properties: propR.data || [],
    insurance: insR.data || [],
    contracts: conR.data || [],
    contractSteps: conEscR.data || [],
    abatements,
    insuranceRequests: insReqR.data || [],
    corporations: corpR.data || [],
    annualReports: arR.data || [],
    // Documents awaiting the LANDLORD — signed and needing his countersignature, or executed
    // and never applied. Only the two open states are fetched: an envelope still out with
    // the tenant raises nothing (he can't act on it), and the three settled states are
    // history. Fetched only when the module is on, and the signer's name is stitched in so
    // the alert can say who signed. Skipped entirely on error → no alert rather than a wrong one.
    ...(esignOn ? { envelopes: await fetchOpenEnvelopes() } : { envelopes: [] }),
    // Precomputed inputs for the two Rent Ledger reminders — built from the SAME math the
    // Ledger grid paints, honoring the configurable grace after month end. Only fetched
    // when the Rent Ledger module is on (else both alerts are hidden anyway). Skipped on
    // any error → no alert rather than a wrong one.
    ...(ledgerOn
      ? await computeLedgerAlerts(leases, escalations, abatements, leadDays)
      : { unloggedMonths: [], missingPayments: [] }),
  };
}

// Envelopes the LANDLORD still owes something on, portfolio-wide, with the tenant signer's
// name stitched in. Two queries rather than a nested select for the same reason listEnvelopes
// uses two — postgrest's embedded-resource syntax is not implemented by the demo mock, so a
// nested select would pass every test and return undefined live.
async function fetchOpenEnvelopes() {
  try {
    const envs = await rows(
      supabase.from('signature_envelopes')
        // contract_id (0093) is what lets the alert say "vendor" instead of "tenant", anchor
        // its dismissal key to the contract, and land on the Contracts tab instead of a
        // lease page that does not exist for it.
        .select('id,lease_id,contract_id,property_id,title,status,signed_at,executed_at,applied_at,purpose')
        .in('status', ['signed', 'executed'])
    );
    if (!envs?.length) return [];
    const signers = await rows(
      supabase.from('envelope_signers').select('envelope_id,role,name,typed_name')
        .in('envelope_id', envs.map((e) => e.id))
    );
    const tenantOf = {};
    (signers || []).forEach((s) => { if (s.role === 'tenant') tenantOf[s.envelope_id] = s; });
    return envs.map((e) => ({
      ...e,
      signer_name: tenantOf[e.id]?.name || null,
      signer_typed_name: tenantOf[e.id]?.typed_name || null,
    }));
  } catch {
    return []; // an alert we can't compute is better absent than wrong
  }
}

// One pass over the year's annual invoices producing BOTH ledger reminders:
//
//   unloggedMonths  — [{ property_id, year, months }] · CLOSED months with no money
//                     recorded anywhere on the property. "You haven't logged this yet."
//   missingPayments — [{ lease_id, property_id, tenant_name, year, months, amount }] ·
//                     for months the property DID import, the tenants absent from it.
//                     "The bank is reconciled and this one isn't in it."
//
// The two are mutually exclusive by construction: an imported month has money on it, so
// it can never also read as unlogged. Both reuse owedByMonthForInvoice →
// allocatePayments so the answers match the Ledger tab exactly (never a flat total/12
// that mis-reads a free month or a mid-year start), and neither ever speaks about a
// month still running — the statement only lands after the month closes.
async function computeLedgerAlerts(leases, escalations, abatements, leadDays) {
  const none = { unloggedMonths: [], missingPayments: [] };
  try {
    const year = Number(localDateIso().slice(0, 4));
    const graceDays = Number(leadDays?.unpaid_rent) > 0 ? Number(leadDays.unpaid_rent) : 7;
    const invAll = await rows(
      supabase.from('v_invoice_balances')
        .select('id,lease_id,property_id,year,kind,base_rent_annual,cam_annual,tax_annual,roof_annual,total_amount')
        .eq('year', year)
    );
    const invoices = (invAll || []).filter(isAnnualInvoice);
    if (!invoices.length) return none;
    // import_id is what proves a month was reconciled against the bank rather than ticked
    // by hand — without it the missing-payment alert stays silent.
    const payRows = await rows(
      supabase.from('payments').select('invoice_id,amount,paid_date,period_month,import_id').in('invoice_id', invoices.map((i) => i.id))
    );
    const payByInvoice = {};
    (payRows || []).forEach((p) => { (payByInvoice[p.invoice_id] ||= []).push(p); });
    const escByLease = {};
    (escalations || []).forEach((e) => { (escByLease[e.lease_id] ||= []).push(e); });
    const abaByLease = {};
    (abatements || []).forEach((a) => { (abaByLease[a.lease_id] ||= []).push(a); });
    // ⚠ Per-month charges/credits (0082). The invoice total already CONTAINS Σadj, so
    // without them owedByMonthForInvoice scales the scheduled months to a total that
    // includes a charge they don't carry — smearing a one-month correction across the
    // whole year on the alert path only.
    const adjByLease = await listAdjustmentsByLeases(invoices.map((i) => i.lease_id), year).catch(() => ({}));
    const leaseById = Object.fromEntries((leases || []).map((l) => [l.id, l]));
    const byProperty = {};
    const importedByProperty = {};
    for (const inv of invoices) {
      const lease = leaseById[inv.lease_id];
      if (!lease || lease.is_active === false) continue;
      const adjRows = adjByLease?.[inv.lease_id] || [];
      const owedByMonth = owedByMonthForInvoice(inv, {
        leaseStart: lease.lease_start,
        escalations: escByLease[inv.lease_id] || [],
        abatements: abaByLease[inv.lease_id] || [],
        adjustments: adjRows,
      });
      if (!owedByMonth) continue; // no gross breakdown → can't judge months; skip
      const pays = payByInvoice[inv.id] || [];
      const allocation = allocatePayments({ owedByMonth, payments: pays, adjustments: monthlyAdjustments(adjRows) });
      (byProperty[inv.property_id] ||= []).push({
        lease_id: inv.lease_id, tenant_name: lease.tenant_name,
        owed: owedByMonth, received: allocation.received,
      });
      pays.forEach((p) => {
        if (!p.import_id || !(p.period_month >= 1 && p.period_month <= 12)) return;
        (importedByProperty[inv.property_id] ||= new Set()).add(Number(p.period_month));
      });
    }
    const today = new Date();
    const out = { unloggedMonths: [], missingPayments: [] };
    for (const [property_id, propRows] of Object.entries(byProperty)) {
      const months = unloggedMonths({ year, rows: propRows, today, graceDays });
      if (months.length) out.unloggedMonths.push({ property_id, year, months });
      const missing = missingOnImportedMonths({
        year, rows: propRows, today, graceDays,
        importedMonths: [...(importedByProperty[property_id] || [])],
      });
      missing.forEach((m) => out.missingPayments.push({ ...m, property_id, year }));
    }
    return out;
  } catch {
    return none;
  }
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

// ---- Notification lead times (how far ahead each alert fires) ----------------
// One per-user row (user_preferences.notify_lead_times jsonb, migration 0065),
// { type_key: days }. Returns {} for a fresh account / any error → the app falls
// back to the built-in defaults (notifyPrefs.js), which match today's behavior.
export async function getNotifyLeadTimes() {
  try {
    const uid = await ownerId();
    if (!uid) return {};
    const { data } = await supabase
      .from('user_preferences')
      .select('notify_lead_times')
      .eq('user_id', uid)
      .maybeSingle();
    return data?.notify_lead_times || {};
  } catch {
    return {};
  }
}

// Merge a patch into the saved leads (so setting one type doesn't wipe the others),
// then rebuild this owner's reminder rows so a changed lead takes effect immediately
// (instead of at the next nightly cron). The reminder rebuild is best-effort — the
// dashboard alerts already re-read the new lead on the next fetch regardless.
export const setNotifyLeadTimes = async (patch) => {
  const current = await getNotifyLeadTimes();
  const next = { ...current, ...patch };
  Object.keys(next).forEach((k) => { if (next[k] == null) delete next[k]; });
  const saved = await one(
    supabase
      .from('user_preferences')
      .upsert(
        { user_id: await ownerId(), notify_lead_times: next, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' }
      )
      .select()
      .single()
  );
  try { await supabase.rpc('regenerate_owner_reminders'); } catch { /* email reminders re-arm next cron */ }
  return saved;
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
  // Lapsed options are not a live decision — the term already ended, or the notice
  // window belonged to a term the lease has since been extended past. Either way,
  // stop asking. (optionLapseReason, src/lib/renewals.js — SQL twin in 0068.)
  if (optionLapsed(ren, termEnd, todayIso)) return false;
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
const addDaysIso = (iso, n) => {
  if (!iso) return null;
  const d = new Date(String(iso) + 'T12:00:00');
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + n);
  return localDateIso(d);
};

// The option's own rent steps, dated and turned into rent_escalations rows. Only reached
// when the option is actually applied — that is what makes a stored schedule "hidden but
// remembered". A boundary that already has a step within 45 days is skipped, so a lease
// whose imported schedule already prints the option years (Ricki's) can't end up with two
// steps a fortnight apart — and, in the caught-up branch, so the year-1 step booked
// alongside base_rent isn't booked twice.
//
// Year 1 starts the day AFTER the committed term ends: the tenant occupies through the
// end date, so the renewal period begins the next day. Same convention as optionWindows
// and buildRenewalScheduleSteps, which is what lets the dialog's per-year dates be the
// dates actually written. (The flat / +%/yr paths below still date year 1 on the term end
// itself — pre-existing, left alone rather than moved under a live billing path.)
async function optionScheduleRows(leaseId, uid, termEndIso, schedule, knownEscalations = null) {
  const anchor = addDaysIso(termEndIso, 1);
  if (!anchor) return [];
  const escs = knownEscalations || (await listEscalations(leaseId));
  const dated = (escs || []).filter((e) => e.effective_date);
  const daysApart = (a, b) => Math.round(Math.abs(new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000);
  const out = [];
  for (const s of schedule) {
    const d = addMonths(anchor, s.off);
    if (!d) continue;
    if (dated.some((e) => daysApart(String(e.effective_date), d) <= 45)) continue;
    if (out.some((r) => daysApart(r.effective_date, d) <= 45)) continue;
    out.push({
      lease_id: leaseId,
      owner_id: uid,
      effective_date: d,
      escalation_type: 'manual',
      escalation_value: null,
      new_base_rent: s.annual,
      status: 'scheduled', // backfillLeaseToToday applies any that are already past
    });
  }
  return out;
}

async function rollLeaseIntoRenewal(lease, ren, uid, corpCache = new Map(), newRentOverride = null, today = new Date()) {
  const newStart = lease.lease_termination_date;              // new term begins as the old one ends
  const newEnd = addMonths(lease.lease_termination_date, ren.term_months || 12);
  const oldRent = Number(lease.base_rent) || 0;
  // First renewal-year rent — one shared rule (renewalFirstYearRent, ./renewals) so the
  // figure the confirm dialog warns about is exactly the figure written here.
  const pct = Number(ren.annual_escalation_pct) || 0;
  // Rent steps the option itself carries (0071). Remembered on the option and made real
  // only here — the landlord entered them when writing the option down, months or years
  // before the tenant decided anything.
  const schedule = optionScheduleSteps(ren.rent_schedule);
  const newRent = renewalFirstYearRent(ren, oldRent, newRentOverride);
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
    // 3b) materialize the rent movements INSIDE the option period. An explicit schedule
    // the option carries wins over the +%/yr formula — it's what the lease actually
    // prints. Either way this is the moment those steps stop being hypothetical.
    if (newStart && (schedule.length || pct > 0)) {
      const escRows = schedule.length
        ? await optionScheduleRows(lease.id, uid, newStart, schedule)
        : Array.from({ length: Math.max(0, years - 1) }, (_, i) => ({
            lease_id: lease.id,
            owner_id: uid,
            effective_date: addMonths(newStart, (i + 1) * 12),
            escalation_type: 'percent',
            escalation_value: pct,
            new_base_rent: round2(newRent * Math.pow(1 + pct / 100, i + 1)),
            status: 'scheduled',
          }));
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
    let escRows;
    if (schedule.length) {
      // The option's own year-by-year rents, made real at the moment it's exercised.
      escRows = await optionScheduleRows(lease.id, uid, newStart, schedule, escs);
    } else {
      escRows = [];
      for (let y = 0; y < years; y++) {
        if (y >= 1 && pct <= 0) break;               // flat option → only the year-1 step matters
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

  // Guard: confirming books the option's first-year rent. When that lands BELOW the
  // rent in effect today it is usually a stale option quoting an earlier term's figure
  // (the 2026-07-28 case: a 2008 option offering $19,386 against a current $31,800.96).
  // Genuine decreases do happen, so this is a confirmation, not a block — the caller
  // re-calls with { acceptDecrease: true } once the landlord has seen both figures.
  // Returned from here rather than from a screen so every entry point inherits it.
  const currentRent = Number(lease.base_rent) || 0;
  const bookedRent = renewalFirstYearRent(ren, currentRent, opts.newRent);
  if (!opts.acceptDecrease && currentRent > 0 && bookedRent > 0 && bookedRent < currentRent - 0.005) {
    return {
      needsDecreaseOk: true,
      renewalId: ren.id,
      optionLabel: ren.option_label || null,
      currentRent,
      newRent: bookedRent,
      effectiveFrom: lease.lease_termination_date,
    };
  }

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
  // Confirming a renewal books its first-year rent and extends the term — two billed figures
  // (CLAUDE.md §1) — so the stored invoice has to follow. After the back-fill, so it is built
  // from the rent the renewal actually leaves in place. A renewal that begins next year finds
  // no invoice for this one and no-ops; a closed year is skipped.
  if (lease.property_id) {
    await resyncLeaseBilling(lease.id, lease.property_id, Number(localDateIso(today).slice(0, 4)))
      .catch(() => null);
  }
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

// Record that an option was exercised YEARS AGO, as history — without touching the lease.
//
// The case (George, 2026-07-29): a 2004 lease carries a "First Option to Renew" with a
// notice date of 2008-09-01. The tenant did renew, back then; everything since has been
// carried by addendums, so the lease already reads the right rent ($31,800.96) and the
// right term end (2030-05-31). The option row, though, still sat **pending** — so it kept
// posing as an open decision, and the only two answers on offer were both wrong: "Renew"
// would have extended the term again and booked that 2008-era rent, and "Not renewing" is
// simply untrue.
//
// So this is the third answer: it happened, and it's over. Status → applied at the date it
// happened, a dated history event so the property timeline shows it, and the stale prompt
// cleared. It deliberately writes NOTHING to the lease — no term, no rent, no escalation —
// because the lease's current figures already reflect everything that followed, and moving
// them is exactly the damage this avoids. (confirmRenewal is still the path for an option
// being exercised NOW.)
export async function markRenewalRenewedHistoric(renewalId, renewedOn) {
  const ren = await one(supabase.from('renewal_options').select('lease_id, option_label, notice_by_date, term_months').eq('id', renewalId).maybeSingle());
  if (!ren) return null;
  const dateIso = isoDateOrNull(renewedOn) || localDateIso(new Date());
  // Noon UTC, so the calendar day reads the same in every timezone the landlord might be in
  // (applied_at is a timestamptz; midnight would render as the day before west of UTC).
  await updateRenewal(renewalId, { status: 'applied', applied_at: `${dateIso}T12:00:00Z` });
  const lease = await getLease(ren.lease_id);
  await logHistoryEvent({
    property_id: lease?.property_id || null,
    lease_id: ren.lease_id,
    type: 'renewal_confirmed',
    tenant_name: lease?.tenant_name || null,
    description: `Renewal exercised${ren.option_label ? ` (${ren.option_label})` : ''} — recorded after the fact; the lease's term and rent were not changed`,
    event_date: dateIso,
    meta: { renewal_id: renewalId, historic: true },
  });
  // It is no longer an open question, so the bell stops asking.
  await rows(supabase.from('notifications').delete().eq('lease_id', ren.lease_id).eq('kind', 'renewal_decision'));
  return { renewalId, renewedOn: dateIso };
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
  // Forward acceptDecrease so the bell can re-call after showing the below-current-rent
  // warning, exactly as the lease page does.
  return confirmRenewal(opt.id, today, { newRent: opts.newRent, acceptDecrease: opts.acceptDecrease });
}
export async function declineRenewalForLease(leaseId) {
  const pending = await rows(
    supabase.from('renewal_options').select('*').eq('lease_id', leaseId).eq('status', 'pending').order('notice_by_date')
  );
  if (pending.length) { await declineRenewal(pending[0].id); return pending[0].id; }
  await rows(supabase.from('notifications').delete().eq('lease_id', leaseId).eq('kind', 'renewal_decision'));
  return null;
}

/**
 * The "please name us as additional insured" letter to a VENDOR, as a ready-to-send draft.
 *
 * The contracts-tab sibling of the insurance vault's own additional-insured request, which
 * is what George asked for (2026-08-05: *"the same email as the insurance template should be
 * added as a button"*). Drafted here rather than in the component for the same reason every
 * other letter is: the send modal takes one shape, and a component composing its own would
 * be a second place the business name and reply-to could be wrong.
 *
 * ⚠ IT DRAFTS. Nothing sends until the landlord presses send in the modal — the standing
 * rule for anything reaching an outside recipient.
 */
export async function draftContractAdditionalInsuredEmail(contractId) {
  const c = await getServiceContract(contractId);
  if (!c) return null;
  const prop = c.property_id ? await getProperty(c.property_id) : null;
  const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
  const email = buildVendorAdditionalInsuredEmail({
    business,
    vendorName: c.vendor || null,
    vendorEmail: c.vendor_email || '',
    contractName: c.name || null,
    propertyName: prop?.name,
    serviceLabel: SERVICE_TYPE_LABEL[c.service_type] || null,
  });
  return {
    kind: 'contract_additional_insured',
    email_heading: 'Email to vendor',
    property_id: c.property_id || null,
    email_to: c.vendor_email || '',
    email_from: business?.contact_email || '',
    email_subject: email.subject,
    email_body: email.body,
  };
}

// Read by the letter above so it can say "landscaping services" rather than "the services".
// Deliberately a bare map, not an import from the Contracts component: api.js is imported by
// the component, never the other way round.
const SERVICE_TYPE_LABEL = {
  landscaping: 'Landscaping', snow_removal: 'Snow removal', security: 'Security', other: '',
};

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
    return { kind: 'contract_renewal', email_heading: 'Email to vendor', email_to: contract.vendor_email || '', email_to_2: '', email_from: business?.contact_email || '', email_subject: email.subject, email_body: email.body };
  }

  // Cancellation notice due → the NON-renewal letter. The opposite decision to the one
  // above, with a deadline on it: an auto-renewing agreement commits the landlord to
  // another full term unless written notice lands by that date. It DRAFTS — the landlord
  // reads it in the send modal and sends it himself.
  if (focus === 'contract_notice') {
    const contract = await one(supabase.from('service_contracts').select('*').eq('id', alert.contract_id).maybeSingle());
    if (!contract) return null;
    const prop = contract.property_id ? await getProperty(contract.property_id) : null;
    const business = businessFromCorp(prop?.corporation_id ? await getCorporation(prop.corporation_id) : null);
    const email = buildContractNonRenewalEmail({
      business,
      vendorName: contract.vendor || contract.name,
      vendorEmail: contract.vendor_email,
      contractName: contract.name || contract.vendor,
      propertyName: prop?.name,
      endDate: contract.end_date,
      noticeDays: contract.notice_days,
      noticeByDate: contract.notice_by_date,
    });
    return { kind: 'contract_renewal', email_heading: 'Email to vendor', email_to: contract.vendor_email || '', email_to_2: '', email_from: business?.contact_email || '', email_subject: email.subject, email_body: email.body };
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
  if (focus === 'insurance') {
    return wrap(buildInsuranceRenewalRequestEmail({ ...common, insurer: alert.insurer, expiryDate: alert.expiry_date, expired: alert.expired }), 'insurance_request');
  }
  // The chase-up fires precisely BECAUSE a first request went unanswered, so re-sending
  // the same letter would read as though we'd forgotten we asked. Its own letter says so
  // — second request, dated from the first — and carries the request date the alert holds.
  // Kind stays 'insurance_request' so sending it logs another insurance_requested event:
  // the "📨 Last requested" line moves to today and the chase-up re-arms from there.
  if (focus === 'insurance_chase') {
    return wrap(buildInsuranceSecondRequestEmail({ ...common, insurer: alert.insurer, expiryDate: alert.expiry_date, expired: alert.expired, requestedDate: alert.date }), 'insurance_request');
  }
  // Nothing on file. If we have never asked, this is a plain FIRST request — using the
  // renewed-certificate letter would name a policy that doesn't exist. If we asked
  // recently and are still waiting, the second-request letter is the right nudge.
  if (focus === 'insurance_missing') {
    return wrap(
      alert.requested
        ? buildInsuranceSecondRequestEmail({ ...common, requestedDate: alert.requested_on })
        : buildInsuranceRequestEmail(common),
      'insurance_request',
    );
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
      // "180 days prior" OR "twelve (12) months prior" (digits may sit inside parens) →
      // N days/months before the term then in effect.
      const m = /(\d+)\s*\)?\s*(day|month)s?\s*prior/i.exec(opt.notes || '');
      if (m && termEnd) {
        const n = Number(m[1]);
        const unit = /month/i.test(m[2]) ? 'months' : 'days';
        patch.notice_by_date = unit === 'months' ? addMonths(termEnd, -n) : addDays(termEnd, -n);
        // Keep the RULE the clause states, not just the date it works out to (0072), so
        // an imported option reads back the same way a hand-entered one does — and can
        // be re-dated from the same rule if the term it counts from ever moves.
        patch.notice_lead_n = n;
        patch.notice_lead_unit = unit;
      }
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
    // A lapsed option isn't a live decision. The term-ended case is caught above; this
    // catches the option whose NOTICE window belonged to a term an addendum has since
    // extended past — its prompt is stale, so clear it rather than leaving the landlord
    // a "Yes — apply renewal" button that books an earlier term's rent.
    if (ren && optionLapsed(ren, lease.lease_termination_date, todayIso)) {
      await rows(supabase.from('notifications').delete().eq('lease_id', l.id).eq('kind', 'renewal_decision'));
      continue;
    }
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
// immutable snapshot so History never recomputes against later edits. Since the
// Rent Ledger, the breakdown also freezes each tenant's COLLECTION picture —
// projected (the year's billed total), collected, collection_rate, and the
// 12-month collected array — so History can chart collection trends year over
// year. Older snapshots simply lack the keys; every consumer renders "—" then.
export async function closeYear(propertyId, year) {
  const [totals, shares, roll] = await Promise.all([
    getPropertyTotals(propertyId, year),
    getTenantShares(propertyId, year),
    getPropertyMonthlyRoll(propertyId, year).catch(() => []),
  ]);
  if (!totals) throw new Error('Enter expenses for this year before closing it.');

  const collectionByLease = {};
  for (const r of roll || []) {
    const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
    // Projected is the FORWARD-ONLY year total (settled months frozen at what was received,
    // open months at the current owed) — the same Y the live Ledger measures collected
    // against, so a fully-settled year freezes at exactly 100% and a later estimate edit
    // never re-prices a month already paid.
    const sum = ledgerRowSummary({ year, owedByMonth: r.schedule, allocation: alloc });
    const projected = sum.projected;
    // Raw collected — an overpaid tenant can read a rate > 100% (truthful, unclamped).
    const collected = alloc.totalPaid;
    collectionByLease[r.lease_id] = {
      projected,
      // What the LEASE billed for the year, kept beside what was collected against it —
      // the pair is the payment difference, preserved once the year is frozen.
      billed: sum.billed,
      variance: sum.variance,
      collected,
      collection_rate: projected > 0 ? Math.round((collected / projected) * 1000) / 1000 : null,
      // Real dollars received per month (a settled month = the tagged amount, a pooled
      // month = its FIFO draw) — the by-month collection history the chart reads back.
      collected_by_month: alloc.received,
    };
  }

  const breakdown = shares.map((s) => ({
    tenant: s.tenant_name,
    square_footage: s.square_footage,
    base_rent: s.base_rent,
    share_pct: s.share_pct,
    tax_amount: s.tax_amount,
    cam_amount: s.cam_amount,
    ...(collectionByLease[s.lease_id] || {}),
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
export async function saveImportRule({ property_id, pattern, target_kind, lease_id = null, cam_label = null, account_hint = null }) {
  const clean = String(pattern || '').trim();
  if (clean.length < 3) throw new Error('A rule pattern needs at least 3 characters.');
  try {
    return await one(
      supabase.from('import_rules')
        .insert({ property_id, pattern: clean, target_kind, lease_id, cam_label, account_hint, owner_id: await ownerId() })
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
            .update({ target_kind, lease_id, cam_label, account_hint })
            .eq('id', existing.id).select().single()
        );
      }
    }
    throw e;
  }
}

export const deleteImportRule = (id) => rows(supabase.from('import_rules').delete().eq('id', id));

// The import register, newest first (sorted here — portable across live + mock).
// Scoped to a fiscal year when one is given, so the log resets with the year the rest
// of the page follows instead of stacking every statement ever imported. A row from
// before the year was recorded (year null) stays visible in every year rather than
// disappearing from the record.
export async function listStatementImports(propertyId, year = null) {
  const list = await rows(supabase.from('statement_imports').select('*').eq('property_id', propertyId));
  const y = Number(year);
  const scoped = y ? (list || []).filter((r) => r.year == null || Number(r.year) === y) : (list || []);
  return [...scoped].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// ── Slice 4a — the audit record ────────────────────────────────────────────────
// One row per TRANSCRIBED line (0076), whether or not it wrote anything. Distinct
// from statement_imports.applied, which is the UNDO record: `applied` says what to
// reverse, these say what the statement contained and what we decided about it.

export const listStatementLines = (importId) =>
  rows(supabase.from('statement_lines').select('*').eq('import_id', importId));

// The nag: money the statement showed that nobody has placed. Scoped to the fiscal
// year the Ledger page follows, newest first. A line whose own date put it in another
// year belongs to that year's list, not this one.
export async function listUnplacedLines(propertyId, year = null) {
  const list = await rows(
    supabase.from('statement_lines').select('*')
      .eq('property_id', propertyId)
      .eq('disposition', 'unclassified')
  );
  const y = Number(year);
  const scoped = y ? (list || []).filter((r) => r.year == null || Number(r.year) === y) : (list || []);
  return [...scoped].sort((a, b) => String(b.txn_date || '').localeCompare(String(a.txn_date || '')));
}

// Change a line's disposition after the fact. Today that means answering the nag —
// "yes, leave this one out" — with an optional reason. Rounds 7 and 8 point it at
// their new destinations. Deliberately does NOT write money: placing a line as an
// expense or a payment has to go through the import path that also books the row.
export const setLineDisposition = (id, disposition, ignoreReason = null, ref = null) =>
  one(
    supabase.from('statement_lines')
      .update({
        disposition,
        ignore_reason: disposition === 'ignored' ? ignoreReason : null,
        // Slice 4b: a line placed AFTER the import still names what it produced, so
        // the audit row stays as traceable as one placed during it.
        ...(ref ? { ref_kind: ref.kind || null, ref_id: ref.id || null } : {}),
      })
      .eq('id', id).select().single()
  );

// ---- Entity ledger (Slice 4b) -----------------------------------------------
// Owner draws, owner contributions, and costs of the LLC itself. See
// src/lib/entityLedger.js for what each means and why a draw is never an expense.
//
// ⚠ Nothing here touches expense_records, cam_line_items, v_tenant_shares or
// v_property_totals. That is the entire safety property: a distribution recorded
// through this path cannot move a tenant's bill or the property's NOI, by
// construction rather than by care.

// Scoped either way: by property (what left this building's account) or by
// corporation (everything the entity did, including rows with no property).
export async function listEntityLedger({ propertyId = null, corporationId = null, year = null } = {}) {
  let q = supabase.from('entity_ledger').select('*');
  if (propertyId) q = q.eq('property_id', propertyId);
  else if (corporationId) q = q.eq('corporation_id', corporationId);
  const list = await rows(q);
  const y = Number(year);
  const scoped = y ? (list || []).filter((r) => r.year == null || Number(r.year) === y) : (list || []);
  return [...scoped].sort((a, b) => String(b.txn_date || '').localeCompare(String(a.txn_date || '')));
}

// Every corporation's entity ledger for a year, in ONE query — for the corporation
// cards, which already read a batched roll-up rather than one query per corp.
export async function listEntityLedgerByCorps(year) {
  const list = await rows(supabase.from('entity_ledger').select('corporation_id,kind,amount,year'));
  const y = Number(year);
  const out = {};
  for (const r of list || []) {
    if (y && r.year != null && Number(r.year) !== y) continue;
    (out[r.corporation_id] ||= []).push(r);
  }
  return out;
}

export async function addEntityLedgerEntry(entry) {
  return one(
    supabase.from('entity_ledger')
      .insert({
        corporation_id: entry.corporation_id,
        property_id: entry.property_id || null,
        year: Number(entry.year) || null,
        kind: entry.kind,
        category: entry.category || null,
        label: entry.label || null,
        amount: Math.abs(Number(entry.amount) || 0),
        txn_date: entry.txn_date || null,
        note: entry.note || null,
        import_id: entry.import_id || null,
        line_hash: entry.line_hash || null,
        owner_id: await ownerId(),
      })
      .select().single()
  );
}

export const deleteEntityLedgerEntry = (id) =>
  rows(supabase.from('entity_ledger').delete().eq('id', id));

// Only an entity COST files on a line of the return, so only a cost has a category.
export const setEntityLedgerCategory = (id, category) =>
  one(supabase.from('entity_ledger').update({ category: category || null }).eq('id', id).select().single());

// ---- Other income (Slice 4c) -------------------------------------------------
// Income the property really received that is not tenant rent. See
// src/lib/otherIncome.js for why it needs its own home rather than the nearest lease.
//
// ⚠ Same safety property as the entity ledger, in the opposite direction: nothing
// here touches `payments`, so a late fee can never credit a tenant's invoice and make
// the Ledger read the month over-paid. `lease_id` records WHO it came from without
// billing anything — attribution and billing are different questions, and this table
// answers only the first.
export async function listOtherIncome(propertyId, year = null) {
  const list = await rows(supabase.from('other_income').select('*').eq('property_id', propertyId));
  const y = Number(year);
  const scoped = y ? (list || []).filter((r) => r.year == null || Number(r.year) === y) : (list || []);
  return [...scoped].sort((a, b) => String(b.txn_date || '').localeCompare(String(a.txn_date || '')));
}

export async function addOtherIncomeEntry(entry) {
  return one(
    supabase.from('other_income')
      .insert({
        property_id: entry.property_id,
        lease_id: entry.lease_id || null,
        year: Number(entry.year) || null,
        category: entry.category || 'other',
        label: entry.label || null,
        amount: Math.abs(Number(entry.amount) || 0),
        txn_date: entry.txn_date || null,
        note: entry.note || null,
        import_id: entry.import_id || null,
        line_hash: entry.line_hash || null,
        owner_id: await ownerId(),
      })
      .select().single()
  );
}

export const deleteOtherIncomeEntry = (id) =>
  rows(supabase.from('other_income').delete().eq('id', id));

export const setOtherIncomeCategory = (id, category) =>
  one(supabase.from('other_income').update({ category: category || 'other' }).eq('id', id).select().single());

// ---- Security deposits (Slice 4c) --------------------------------------------
// What the LEASE says is held lives on the lease (`security_deposit`). What the BANK
// showed arriving is a 0076 line whose disposition is 'deposit_held' and whose ref
// points at that lease — so there is deliberately no third table, and therefore no
// third figure that can start disagreeing with the other two.
export const listDepositLinesForLease = (leaseId) =>
  rows(
    supabase.from('statement_lines').select('*')
      .eq('disposition', 'deposit_held')
      .eq('ref_id', leaseId)
  );

// The deposit is a lease TERM, so saving it is a lease edit — and deliberately NOT
// routed through BILLING_FIELDS/resyncLeaseBilling: a deposit changes no rent, no
// share and no invoice, so re-billing the year on the back of it would be a write
// with no cause.
export const setLeaseSecurityDeposit = (leaseId, amount) =>
  one(
    supabase.from('leases')
      .update({ security_deposit: amount === '' || amount == null ? null : Math.abs(Number(amount) || 0) })
      .eq('id', leaseId).select().single()
  );

// ---- Fixed assets (Slice 5a) -------------------------------------------------
// Depreciable things standing at a property. See src/lib/depreciation.js for why the
// arithmetic lives there and nothing is stored.
//
// ⚠ NOTE THE ABSENCE OF A YEAR FILTER, and it is not an oversight. Every other list in
// this file is scoped to a fiscal year because every other figure belongs to one. An
// asset belongs to ALL of them: it has a date it entered service and a life spanning
// decades, and the year's figure is derived from the schedule. Filtering by year here
// would hide the building from every year but the one it was bought in.
export const listFixedAssets = (propertyId) =>
  rows(supabase.from('fixed_assets').select('*').eq('property_id', propertyId));

export async function addFixedAsset(asset) {
  const numOrNull = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
  return one(
    supabase.from('fixed_assets')
      .insert({
        property_id: asset.property_id,
        kind: asset.kind || null,
        description: asset.description || null,
        placed_in_service: asset.placed_in_service || null,
        cost: Math.abs(Number(asset.cost) || 0),
        // Preserved as null when unanswered — the whole land refusal turns on it, so
        // it must never be coerced to 0 on the way in.
        land_cost: asset.land_cost === '' || asset.land_cost == null ? null : Math.abs(Number(asset.land_cost) || 0),
        useful_life_years: numOrNull(asset.useful_life_years),
        prior_accumulated: numOrNull(asset.prior_accumulated),
        prior_accumulated_year: numOrNull(asset.prior_accumulated_year),
        note: asset.note || null,
        // Slice 5b. Both nullable and both default to nothing: an asset bills nothing
        // back until amortize_into is set, and import_id is present only when the asset
        // was capitalized straight off a bank line.
        amortize_into: asset.amortize_into || null,
        import_id: asset.import_id || null,
        owner_id: await ownerId(),
      })
      .select().single()
  );
}

export const deleteFixedAsset = (id) =>
  rows(supabase.from('fixed_assets').delete().eq('id', id));

// The one edit worth a dedicated call: the land allocation is what unblocks a building's
// schedule, so it is set from a chip on the row rather than by re-entering the asset.
export const setFixedAssetLand = (id, landCost) =>
  one(
    supabase.from('fixed_assets')
      .update({ land_cost: landCost === '' || landCost == null ? null : Math.abs(Number(landCost) || 0) })
      .eq('id', id).select().single()
  );

// ---- Slice 5c: the closing statement ----------------------------------------

export async function extractClosingStatement({ text, storagePath }) {
  const { fields } = await invokeFunction('extract-closing-statement', { text, storage_path: storagePath });
  return { fields: fields || {} };
}

// Write the assets a confirmed closing-statement read proposes, and keep the document.
//
// ⚠ IT WRITES ASSETS AND NOTHING ELSE, which is what makes it safe. `fixed_assets` is
// read by no view, no invoice and no share calculation — the same structural safety
// rounds 7-9 have — so reading a closing statement CANNOT move a tenant's bill. The
// prorated property tax the document also carries is deliberately NOT written into that
// year's `taxes_total`: that would re-sum the kind, re-split every tenant's share and
// move bills on a historical year that is very likely closed. Reading a document is not
// a reason to move somebody's rent. The review screen reports the figure instead.
export async function saveClosingStatement(propertyId, assets = [], opts = {}) {
  const created = [];
  for (const a of assets) {
    if (!(Number(a?.cost) > 0)) continue;
    created.push(await addFixedAsset({ ...a, property_id: propertyId }));
  }
  // The paper the figures came from stays reachable from the property that owns them.
  // Best-effort: the assets are the point, and a storage hiccup must not lose them.
  if (opts.storagePath) {
    try {
      await attachDocument(opts.storagePath, { entityType: 'property', entityId: propertyId });
    } catch (_e) { /* the assets are written; the file is simply unlisted */ }
  }
  return created;
}

// ---- Slice 5b: capitalize, and bill it back ---------------------------------

// Switch an asset's amortization on or off. This is the ONE write in this file that can
// change a tenant's bill without a figure being typed, so it is deliberately its own
// call rather than a field on a form: the UI names the consequence before it fires, and
// the caller carries it through.
export async function setAssetAmortization(assetId, into, propertyId, year) {
  const asset = await one(
    supabase.from('fixed_assets')
      .update({ amortize_into: into || null })
      .eq('id', assetId).select().single()
  );
  const sync = await syncAmortizationItems(propertyId, year);
  if (sync.changed) await resyncPropertyBilling(propertyId, Number(year));
  return { asset, ...sync };
}

// One derived expense row per amortizing asset, self-healing on year-open exactly as
// service contracts and rent-percentage fees already are (syncContractCamItems is the
// shape this is cloned from, down to the `changed` signal).
//
// ⚠ THE ROW GOES INTO THE ASSET'S OWN KIND, never into CAM by default. A roof amortizes
// back into roof_total, so only roof_responsible leases pay it; a parking lot amortizes
// into CAM, so everyone does. Getting that backwards would bill eight Pershing tenants
// for a roof their leases exclude.
//
// ⚠ AND IT REFUSES A CLOSED YEAR. resyncPropertyBilling already skips one — a bill that
// has been sent must not move because a screen was opened — so writing the line anyway
// would leave the expense total and the frozen snapshot disagreeing with nothing able to
// reconcile them.
//
// Written through addExpenseLineItem rather than a raw insert, which is load-bearing: a
// roof amortization row can be the FIRST roof line a property has, and carryFlatIntoItems
// is what stops that re-summing a hand-typed roof total down to the amortized figure.
export async function syncAmortizationItems(propertyId, year) {
  const y = Number(year);
  if (await isYearClosed(propertyId, y)) return { changed: false, skipped: 'closed' };

  const [assets, derived] = await Promise.all([
    listFixedAssets(propertyId),
    rows(
      supabase.from('cam_line_items').select('*')
        .eq('property_id', propertyId).eq('year', y).not('asset_id', 'is', null)
    ),
  ]);

  const byAsset = new Map(derived.map((it) => [it.asset_id, it]));
  const kindsTouched = new Set();
  let changed = false;

  for (const a of assets) {
    const am = amortizationFor(a, y);
    const existing = byAsset.get(a.id);
    if (!am) continue;
    if (!existing) {
      await addExpenseLineItem({
        property_id: propertyId, year: y, kind: am.kind,
        label: am.label, amount: am.amount, asset_id: a.id,
      });
      kindsTouched.add(am.kind);
      changed = true;
    } else if (
      Number(existing.amount) !== am.amount
      || existing.label !== am.label
      || existing.kind !== am.kind
    ) {
      // A kind change means the row has to move buckets, not just re-price — otherwise
      // the old kind keeps a stale total. Delete and re-add so both kinds re-sum.
      if (existing.kind !== am.kind) {
        await rows(supabase.from('cam_line_items').delete().eq('id', existing.id));
        kindsTouched.add(existing.kind);
        await addExpenseLineItem({
          property_id: propertyId, year: y, kind: am.kind,
          label: am.label, amount: am.amount, asset_id: a.id,
        });
      } else {
        await one(
          supabase.from('cam_line_items')
            .update({ amount: am.amount, label: am.label })
            .eq('id', existing.id).select().single()
        );
      }
      kindsTouched.add(am.kind);
      changed = true;
    }
  }

  // Remove rows whose asset stopped amortizing, was fully depreciated, or is no longer
  // in service this year — the same cleanup a contract row gets when its term moves.
  const stillAmortizing = new Set(
    assets.filter((a) => amortizationFor(a, y)).map((a) => a.id)
  );
  for (const [assetId, it] of byAsset) {
    if (stillAmortizing.has(assetId)) continue;
    await rows(supabase.from('cam_line_items').delete().eq('id', it.id));
    kindsTouched.add(it.kind);
    changed = true;
  }

  for (const k of kindsTouched) await syncTotalFor(propertyId, y, k);
  return { changed, skipped: null };
}

// ⚠ THE ROUND'S HEADLINE, and the one write in this whole accounting arc that
// deliberately MOVES A TENANT'S BILL.
//
// Round 9 could record an $18,000 roof as an asset but could not take it out of the
// year's roof_total, so a landlord who did both told the app about it twice — named on
// that panel rather than left to be discovered. This is the other half: the expense line
// becomes an asset and stops being an expense.
//
// That is a real billing change. roof_total feeds v_property_totals, which feeds every
// roof-responsible lease's roof_amt, which feeds their invoice — so it runs the full §1
// carry-through and the caller settles the query cache after it.
//
// TWO REFUSALS, both about not moving a figure under a bill that has already gone out:
//   • a CLOSED year is refused outright. Record the asset by hand and leave the expense
//     where it is — the tenants were billed that roof, and that is the history.
//   • an asset needs a date it entered service, and an expense line's paid_date is
//     nullable (0074 deliberately backfilled none). Rather than invent one, the caller
//     supplies it; the UI defaults to the line's own paid_date when it has one.
export async function capitalizeExpenseLine(itemId, fields = {}) {
  const item = await one(supabase.from('cam_line_items').select('*').eq('id', itemId).single());
  if (!item) throw new Error('That expense line no longer exists.');

  const propertyId = item.property_id;
  const year = Number(item.year);
  if (await isYearClosed(propertyId, year)) {
    return { skipped: 'closed', asset: null };
  }

  const placed = fields.placed_in_service || item.paid_date || null;
  if (!placed) return { skipped: 'no_date', asset: null };

  const kind = fields.kind || 'improvement';
  // The asset amortizes back into the kind of expense it came from — the same tenants,
  // spread over the life. Offered only where a lease could support it, and only when the
  // caller asked: `amortize` unset means the cost simply leaves the year's expenses.
  const into = fields.amortize && canAmortize({ kind })
    ? (item.kind === 'roof' ? 'roof' : 'cam')
    : null;

  const asset = await addFixedAsset({
    property_id: propertyId,
    kind,
    description: fields.description || item.label,
    placed_in_service: placed,
    cost: Number(item.amount) || 0,
    land_cost: assetKindInfo(kind).landSplit ? (fields.land_cost ?? null) : null,
    useful_life_years: fields.useful_life_years ?? null,
    amortize_into: into,
    // Provenance rides along: an asset capitalized off a bank line stays clickable back
    // to the stored statement PDF, exactly as the expense line it replaces was.
    import_id: item.import_id || null,
  });

  // Asset FIRST, then remove the expense. An interruption between the two leaves the
  // asset recorded and the expense still standing — visible and fixable — rather than a
  // deleted cost with nothing to show for it.
  await deleteExpenseLineItem(item.id, propertyId, year, item.kind);
  const sync = await syncAmortizationItems(propertyId, year);
  const billing = await resyncPropertyBilling(propertyId, year);

  return { asset, skipped: null, amortized: sync.changed, billing, fromKind: item.kind };
}

// Answer the "money not yet placed" nag by giving the line a real home, without
// re-importing the statement it came from. Writes the ledger row FIRST, then stamps
// the line — so an interruption leaves a recorded draw with a still-nagging line
// (visible, fixable) rather than a placed line with no money behind it (invisible).
export async function placeUnplacedLine(line, { kind, corporationId, category = null, leaseId = null }) {
  if (kind === 'transfer') {
    // A transfer writes nothing — the disposition IS the record, exactly as an
    // ignore's is. There is no row to create and none to reverse.
    return { line: await setLineDisposition(line.id, 'transfer'), entry: null };
  }
  // Slice 4c — a security deposit writes nothing either, and that is the design.
  // What is HELD is a lease term; this line is the evidence money arrived. Writing
  // the bank figure onto `leases.security_deposit` would overwrite what the lease
  // says with what the bank shows, collapsing the two independent sources into one
  // and destroying the only cross-check that makes either trustworthy.
  if (kind === 'deposit') {
    return { line: await setLineDisposition(line.id, 'deposit_held', null, { kind: 'lease', id: leaseId }), entry: null };
  }
  if (kind === 'income') {
    const row = await addOtherIncomeEntry({
      property_id: line.property_id,
      lease_id: leaseId,
      year: line.year || null,
      category: category || 'other',
      label: line.description ? String(line.description).slice(0, 200) : null,
      amount: line.amount,
      txn_date: line.txn_date || null,
      import_id: line.import_id || null,
      line_hash: line.line_hash || null,
    });
    const updated = await setLineDisposition(line.id, 'other_income', null, { kind: 'income', id: row.id });
    return { line: updated, entry: row };
  }
  const entry = await addEntityLedgerEntry({
    corporation_id: corporationId,
    property_id: line.property_id || null,
    year: line.year || null,
    kind,
    category,
    label: line.description ? String(line.description).slice(0, 200) : null,
    amount: line.amount,
    txn_date: line.txn_date || null,
    import_id: line.import_id || null,
    line_hash: line.line_hash || null,
  });
  const disposition = kind === 'cost' ? 'entity' : 'owner';
  const updated = await setLineDisposition(line.id, disposition, null, { kind: 'entity', id: entry.id });
  return { line: updated, entry };
}

// Everything the matcher needs, assembled once per import: every property's
// tenants with their year schedule + coverage (so deposits cross-match the WHOLE
// portfolio), open reconciliation balances, the saved rules, the live import-hash
// set (the duplicate guard), and the account→property memory.
export async function getStatementMatchContext(propertyId, year) {
  const [properties, rules, allImports, hashRows, reconRows, camItems, corporations, leaseRows, savedBuckets] = await Promise.all([
    rows(supabase.from('properties').select('id,name,corporation_id')),
    listImportRules(),
    rows(supabase.from('statement_imports').select('*')),
    // postgrest-js's signature is not(column, operator, value) — a single-arg
    // .not('import_hash') builds "import_hash=not.undefined.undefined", which
    // PostgREST rejects with a 400 (it read fine against the demo mock, whose
    // not() took one arg — that divergence hid it). Spell the filter out.
    rows(supabase.from('payments').select('import_hash').not('import_hash', 'is', null)),
    rows(supabase.from('v_invoice_balances').select('*').eq('kind', 'reconciliation')),
    rows(supabase.from('cam_line_items').select('label,billable')),
    rows(supabase.from('corporations').select('*')),
    // security_deposit rides this existing per-lease read rather than being appended
    // to v_tenant_shares — a view rebuild is a permanent mockClient.js obligation
    // (CLAUDE.md §3) and this costs nothing.
    rows(supabase.from('leases').select('id,tenant_email,tenant_email_2,tenant_contact_name,security_deposit')),
    listExpenseBuckets(),
  ]);
  const nameOf = Object.fromEntries((properties || []).map((p) => [p.id, p.name]));
  // Tenant contact identity (for the "payment didn't follow the escalation" letter) and
  // the sending business per property (its corporation's letterhead) — assembled here so
  // the review screen can draft a letter with no extra fetch.
  const leaseInfo = Object.fromEntries((leaseRows || []).map((l) => [l.id, l]));
  const corpById = Object.fromEntries((corporations || []).map((c) => [c.id, c]));
  const businessByProperty = {};
  for (const p of properties || []) businessByProperty[p.id] = businessFromCorp(corpById[p.corporation_id]) || null;

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
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
      const recon = openReconByLease[r.lease_id] || null;
      const info = leaseInfo[r.lease_id] || {};
      // Mid-year rent steps, derived from the SAME per-month components the Ledger
      // boxes paint — so a deposit at the pre-raise rate for a post-step month reads
      // as explained by the escalation, never as "short" (and the import screen can
      // never disagree with the boxes).
      const comp = componentizeSchedule({ schedule: r.schedule, factor: r.factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual, camTaxByMonth: r.camTaxByMonth, roofByMonth: r.roofByMonth, adjustments: r.adjustments });
      const steps = escalationStepMonths({ schedule: r.schedule, comp });
      // Per-month base + roof (the exact figures the Ledger boxes paint) so an imported
      // deposit can back out its CAM & tax estimate: CAM&tax = deposit − base − roof.
      // ⚠ adjByMonth rides along so deriveEstimateFromDeposit can REFUSE a month
      // carrying a one-off charge — otherwise a $250 late fee inside a deposit would
      // derive a permanent +$3,000/yr CAM & tax estimate.
      const baseByMonth = [];
      const roofByMonth = [];
      const adjByMonth = [];
      for (let mm = 1; mm <= 12; mm++) { baseByMonth.push(comp[mm]?.base || 0); roofByMonth.push(comp[mm]?.roof || 0); adjByMonth.push(comp[mm]?.adj || 0); }
      tenants.push({
        lease_id: r.lease_id,
        property_id: p.id,
        property_name: p.name,
        tenant_name: r.tenant_name,
        tenant_email: info.tenant_email || null,
        tenant_email_2: info.tenant_email_2 || null,
        contact_name: info.tenant_contact_name || null,
        // What the LEASE says is held. The matcher uses it to recognize a deposit
        // that would otherwise pre-match as rent — the one case where booking a
        // deposit against the lease corrupts the Ledger rather than merely omitting.
        securityDeposit: info.security_deposit != null ? Number(info.security_deposit) : null,
        monthly: r.monthly,
        owed: alloc.owed,
        coverage: alloc.coverage,
        steps,
        baseByMonth,
        roofByMonth,
        adjByMonth,
        square_footage: Number(r.square_footage) || 0,
        camTaxAnnual: Number(r.camTaxAnnual) || 0,
        anyEstimate: !!r.anyEstimate,
        // A gross tenant's deposit IS the flat rent, so "deposit − base" is its carved
        // expense share, not an estimate to propose. The importer skips it entirely.
        gross: !!r.gross,
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

  // The owner's expense BUCKETS — every distinct label already itemized (across
  // all properties, so a bucket named once is offered everywhere) plus the labels
  // saved on rules. billable=false labels form the "not billed to tenants" family.
  // The review screen merges these with the keyword table's built-in labels.
  // Saved bucket RECORDS (0075) come first — they carry the tax category a human chose,
  // and a bucket can legitimately exist before any line has landed in it. Emergent
  // labels then fill in around them, so a label nobody has categorized still imports
  // and still bills exactly as it did before this table existed.
  const savedByKey = new Map((savedBuckets || []).map((b) => [bucketKey(b.label), b]));
  const decorate = (label, billable) => {
    const saved = savedByKey.get(bucketKey(label));
    const category = (saved?.category && isValidCategory(saved.category)) ? saved.category : defaultCategoryFor(label);
    return {
      label,
      billable: saved ? saved.billable !== false : billable,
      category: category || null,
      // 'saved' = a human chose it · 'default' = the built-in mapping for a label the
      // app proposed · null = nobody has said, and the UI must show it as a figure
      // rather than absorb it into "Other".
      categorySource: saved?.category && isValidCategory(saved.category) ? 'saved' : (category ? 'default' : null),
      capital_prone: saved ? saved.capital_prone === true : isCapitalProne(label),
    };
  };

  const bucketMap = new Map();
  for (const b of savedBuckets || []) {
    const label = String(b.label || '').trim();
    if (label) bucketMap.set(bucketKey(label), decorate(label, b.billable !== false));
  }
  for (const it of camItems || []) {
    const label = String(it.label || '').trim();
    if (label && !bucketMap.has(bucketKey(label))) bucketMap.set(bucketKey(label), decorate(label, it.billable !== false));
  }
  for (const r of rules || []) {
    const label = String(r.cam_label || '').trim();
    if (!label || bucketMap.has(bucketKey(label))) continue;
    if (r.target_kind === 'expense_cam') bucketMap.set(bucketKey(label), decorate(label, true));
    else if (r.target_kind === 'expense_other') bucketMap.set(bucketKey(label), decorate(label, false));
  }
  const buckets = [...bucketMap.values()].sort((a, b) => a.label.localeCompare(b.label));

  // The landlord's own legal entities. A bank names the ACCOUNT HOLDER on its own
  // transfer lines ("… NASA PROPERTY LLC TRN …"), which reads exactly like a payee — so
  // the rule screen is told these names and refuses to learn one as a payee.
  const ownNames = [...new Set((corporations || []).map((c) => String(c.name || '').trim()).filter(Boolean))];

  // Slice 4b: entity-level money belongs to a corporation, and the review screen is
  // standing on a property — so the corporation is derived here rather than fetched
  // again. Already in hand: `properties` selects corporation_id.
  const corporationId = (properties || []).find((p) => p.id === propertyId)?.corporation_id || null;
  return { properties: properties || [], tenants, rules: rules || [], existingHashes, accountMemory, buckets, businessByProperty, ownNames, corporationId };
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
export async function applyStatementImport({ propertyId, year, fileName, accountHint = null, storagePath = null, entries = [], lines = [] }) {
  const imp = await one(
    supabase.from('statement_imports')
      .insert({ property_id: propertyId, year: Number(year) || null, file_name: fileName || null, account_hint: accountHint, storage_path: storagePath || null, applied: [], owner_id: await ownerId() })
      .select().single()
  );
  // The statement itself belongs to the import that read it — the ledger should be
  // able to show you the document a figure came from.
  await attachDocument(storagePath, { entityType: 'statement_import', entityId: imp.id });
  const applied = [];
  let paymentsCount = 0, paymentsTotal = 0, expensesCount = 0, expensesTotal = 0;
  // Entity-level money is counted apart from expenses, because it IS apart from them.
  let entityOutCount = 0, entityOutTotal = 0, entityInCount = 0, entityInTotal = 0;
  // Money IN that is not rent, likewise counted apart from payments: folding a late
  // fee into paymentsTotal would report rent collection that never happened, which is
  // the exact misstatement this slice exists to prevent — one screen earlier.
  let incomeCount = 0, incomeTotal = 0, depositCount = 0, depositTotal = 0;
  // Slice 5b — money out that bought something lasting, counted apart from expenses for
  // the same reason: it is not a cost of this year, and folding it into expensesTotal
  // would report a year of spending that the arithmetic deliberately spreads over decades.
  let capitalCount = 0, capitalTotal = 0;
  const crossProperty = {};
  // Auto-learn payee rules ride the import too (a checked tenant deposit is remembered
  // automatically; an expense only when "Always" is ticked). Loaded once, lazily, so an
  // import with no rule entries pays nothing; each rule's prior target is captured so
  // undo can restore it (reassignment) or delete it (a brand-new rule).
  let existingRules = null;

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
        // Real money off a bank statement. Stored rather than inferred from import_id,
        // because import_id is `on delete set null` (0063) — removing the import used to
        // strip these back to the "looks like the app made it up" shape and make a real
        // deposit re-pricable (0088).
        source: 'import',
      });
      applied.push({ kind: 'payment', payment_id: pay.id, invoice_id: invoiceId, lease_id: e.lease_id, property_id: e.property_id, year: e.year, amount: Number(e.amount), hash: e.hash });
      paymentsCount++; paymentsTotal += Number(e.amount);
      if (e.property_id !== propertyId) {
        crossProperty[e.property_id] = (crossProperty[e.property_id] || 0) + 1;
      }
    } else if (e.type === 'cam') {
      // Each expense line keeps the day the bank printed on it (0074 `paid_date`). The
      // importer has always read that date — it derives the fiscal year FROM it — and
      // until now threw it away, leaving `year` as the only time an expense had.
      const item = await addCamLineItem({ property_id: e.property_id, year: e.year, label: e.label || 'Imported expense', amount: Number(e.amount), import_id: imp.id, billable: e.billable !== false, paid_date: e.date || null });
      applied.push({ kind: 'cam', item_id: item.id, property_id: e.property_id, year: e.year, amount: Number(e.amount), label: e.label || 'Imported expense', billable: e.billable !== false, hash: e.hash });
      expensesCount++; expensesTotal += Number(e.amount);
    } else if (e.type === 'tax') {
      // Every tax payment the statement shows gets its OWN line, the way CAM does —
      // a year's taxes are usually two or three instalments to a county, and one
      // accumulating figure hides which was which (George: "it should put a new line
      // per time it sees it on the statement").
      const item = await addTaxLineItem({ property_id: e.property_id, year: e.year, label: e.label || 'Property tax', amount: Number(e.amount), import_id: imp.id, paid_date: e.date || null });
      applied.push({ kind: 'tax_item', item_id: item.id, property_id: e.property_id, year: e.year, amount: Number(e.amount), label: item.label, hash: e.hash });
      expensesCount++; expensesTotal += Number(e.amount);
    } else if (e.type === 'roof') {
      // The roof books its own line too (0074), exactly as 'tax' did in 0067. A roof is
      // replaced once and repaired several times; a single accumulating figure hid
      // which payment was which — and made undo reverse a subtraction rather than
      // delete a row, which is where the clamp-at-zero wart below came from.
      const item = await addRoofLineItem({ property_id: e.property_id, year: e.year, label: e.label || 'Roof', amount: Number(e.amount), import_id: imp.id, paid_date: e.date || null });
      applied.push({ kind: 'roof_item', item_id: item.id, property_id: e.property_id, year: e.year, amount: Number(e.amount), label: item.label, hash: e.hash });
      expensesCount++; expensesTotal += Number(e.amount);
    } else if (e.type === 'capital') {
      // Slice 5b — bought once, used for years.
      //
      // ⚠ Deliberately NOT counted in expensesCount/expensesTotal, and deliberately NOT
      // an expense line. The whole point is that this cost does not belong to one year:
      // it lands in fixed_assets, which no view, no invoice and no share calculation
      // reads, so capitalizing at import can move no tenant's bill. Billing it back over
      // its life is a separate opt-in decision (setAssetAmortization), made where the
      // consequence can be stated.
      const asset = await addFixedAsset({
        property_id: e.property_id,
        kind: e.asset_kind || 'improvement',
        description: e.label || 'Capital improvement',
        placed_in_service: e.date || null,
        cost: Number(e.amount),
        import_id: imp.id,
      });
      applied.push({ kind: 'capital', asset_id: asset.id, property_id: e.property_id, year: e.year, amount: Number(e.amount), label: asset.description, hash: e.hash });
      capitalCount++; capitalTotal += Number(e.amount);
    } else if (e.type === 'entity') {
      // Slice 4b — a draw, a contribution, or a cost of the LLC itself.
      //
      // ⚠ Deliberately NOT counted in expensesCount/expensesTotal. A draw is not an
      // expense (it reduces equity), and an entity cost is not THIS building's
      // expense — folding either into the import's expense summary would be the same
      // misstatement one screen earlier. They get their own counters.
      const row = await addEntityLedgerEntry({
        corporation_id: e.corporation_id,
        property_id: e.property_id || propertyId,
        year: e.year,
        kind: e.kind,
        category: e.category || null,
        label: e.label || (e.description ? String(e.description).slice(0, 200) : null),
        amount: Number(e.amount),
        txn_date: e.date || null,
        import_id: imp.id,
        line_hash: e.hash || null,
      });
      applied.push({ kind: 'entity', entry_id: row.id, entity_kind: e.kind, corporation_id: e.corporation_id, property_id: e.property_id || propertyId, year: e.year, amount: Number(e.amount), hash: e.hash });
      if (e.kind === 'contribution') { entityInCount++; entityInTotal += Number(e.amount); }
      else { entityOutCount++; entityOutTotal += Number(e.amount); }
    } else if (e.type === 'income') {
      // Slice 4c — real income of the property that is not rent.
      //
      // ⚠ Deliberately NOT a payment. Booking a late fee against the tenant who paid
      // it would credit their annual invoice, so allocatePayments reads the month
      // over-paid and the Ledger's Collected column reports rent that never arrived.
      // `lease_id` records who it came from; nothing bills anything.
      const row = await addOtherIncomeEntry({
        property_id: e.property_id || propertyId,
        lease_id: e.lease_id || null,
        year: e.year,
        category: e.category || 'other',
        label: e.label || (e.description ? String(e.description).slice(0, 200) : null),
        amount: Number(e.amount),
        txn_date: e.date || null,
        import_id: imp.id,
        line_hash: e.hash || null,
      });
      applied.push({ kind: 'income', entry_id: row.id, property_id: e.property_id || propertyId, year: e.year, amount: Number(e.amount), hash: e.hash });
      incomeCount++; incomeTotal += Number(e.amount);
    } else if (e.type === 'deposit') {
      // A security deposit received. It writes NO row on purpose: what is HELD is a
      // lease term, and this line is the evidence money arrived. Stamping the bank
      // figure onto leases.security_deposit would overwrite what the lease says with
      // what the bank shows and destroy the cross-check between them. The line's own
      // disposition + ref IS the record (0076), so `applied` carries nothing to undo
      // beyond the line itself, which undo deletes wholesale. The applied record
      // exists purely so the audit LINE learns which lease it belongs to — that ref
      // is what the cross-check reads back.
      applied.push({ kind: 'deposit', lease_id: e.lease_id || null, property_id: e.property_id || propertyId, year: e.year, amount: Number(e.amount), hash: e.hash });
      depositCount++; depositTotal += Number(e.amount);
    } else if (e.type === 'estimate') {
      // A CAM & tax estimate read from a deposit (Feature: deriveEstimateFromDeposit).
      // Processed FIRST (the review puts estimate entries ahead of payments in the
      // array) so the year's billing is resynced to base + the new estimate BEFORE the
      // deposits book — then each deposit settles its month exactly (✓, no gold "under").
      // Capture the lease's prior estimate so undo restores it precisely; write the 7/20
      // combined convention (whole figure on est_cam_annual, est_tax_annual = 0) and
      // stamp est_confirmed_year so the carried-over note clears. Same write path as the
      // hand-typed estimate editor, so every downstream surface repopulates identically.
      const leaseRow = await one(supabase.from('leases').select('est_cam_annual,est_tax_annual,est_roof_annual,est_confirmed_year,tenant_name').eq('id', e.lease_id).single());
      const prior = {
        est_cam_annual: leaseRow?.est_cam_annual ?? null,
        est_tax_annual: leaseRow?.est_tax_annual ?? null,
        est_roof_annual: leaseRow?.est_roof_annual ?? null,
        est_confirmed_year: leaseRow?.est_confirmed_year ?? null,
      };
      await updateLease(e.lease_id, { est_cam_annual: Number(e.est_cam_annual), est_tax_annual: 0, est_confirmed_year: Number(e.year) });
      await resyncYearBillingToEstimate(e.lease_id, e.property_id, e.year);
      applied.push({ kind: 'estimate', lease_id: e.lease_id, property_id: e.property_id, year: e.year, amount: Number(e.est_cam_annual), prior });
      await logHistoryEvent({
        property_id: e.property_id, lease_id: e.lease_id, type: 'estimate_set', tenant_name: leaseRow?.tenant_name || null,
        description: `CAM & tax estimate set from ${fileName || 'a bank statement'}: ${money(Number(e.est_cam_annual))}/yr`,
      });
    } else if (e.type === 'rule') {
      // Learn (or overwrite) a payee → target rule. Best-effort: a failure here must
      // never lose the import. NO hash on the applied record — a rule isn't a money
      // line, so it stays out of the duplicate-guard universe.
      try {
        if (existingRules == null) existingRules = await listImportRules();
        const prevRow = existingRules.find(
          (r) => r.property_id === e.property_id && String(r.pattern).toLowerCase() === String(e.pattern).toLowerCase()
        );
        // The no-op test is on the TARGET fields only (preserves "re-learn the same
        // target → nothing to undo"). The account hint is metadata, so a same-target
        // re-learn from a NEW account just refreshes the hint (last-import-wins) with
        // NO applied record — a hint-only change never touched a money line, so it's
        // intentionally not reversed by undo.
        const same = prevRow
          && prevRow.target_kind === e.target_kind
          && (prevRow.lease_id || null) === (e.lease_id || null)
          && (prevRow.cam_label || null) === (e.cam_label || null);
        if (same) {
          if (accountHint && (prevRow.account_hint || null) !== accountHint) {
            const refreshed = await saveImportRule({ property_id: e.property_id, pattern: e.pattern, target_kind: e.target_kind, lease_id: e.lease_id || null, cam_label: e.cam_label || null, account_hint: accountHint });
            existingRules = existingRules.filter((r) => r.id !== refreshed.id).concat([refreshed]);
          }
          continue;
        }
        const prior = prevRow ? { target_kind: prevRow.target_kind, lease_id: prevRow.lease_id || null, cam_label: prevRow.cam_label || null, account_hint: prevRow.account_hint || null } : null;
        const rule = await saveImportRule({ property_id: e.property_id, pattern: e.pattern, target_kind: e.target_kind, lease_id: e.lease_id || null, cam_label: e.cam_label || null, account_hint: accountHint || null });
        applied.push({ kind: 'rule', rule_id: rule.id, pattern: e.pattern, property_id: e.property_id, lease_id: e.lease_id || null, prior });
        existingRules = existingRules.filter((r) => r.id !== rule.id).concat([rule]);
      } catch { /* learning is best-effort — the import still succeeds */ }
    }
  }

  // The audit record: one row per line the statement CONTAINED, including every line
  // that wrote nothing. Before this, an unrecognized line left untouched produced no
  // write and no trace at all, so "did I ever book that Comcast bill?" was
  // unanswerable inside the app.
  //
  // Written AFTER the entries loop so each line can name what it produced. The map is
  // a QUEUE per hash, not a lookup: two byte-identical lines on one statement share a
  // hash, and shifting gives the second its own payment rather than pointing both at
  // the first. Best-effort as a whole — an audit row failing must never lose an import
  // that has already written real money.
  try {
    if (lines.length) {
      const byHash = new Map();
      for (const a of applied) {
        if (!a.hash) continue; // 'rule' records carry none — they aren't money lines
        if (!byHash.has(a.hash)) byHash.set(a.hash, []);
        byHash.get(a.hash).push(a);
      }
      const oid = await ownerId();
      const rowsToWrite = lines.map((l) => {
        const q = byHash.get(l.hash);
        const ref = q && q.length ? q.shift() : null;
        return {
          owner_id: oid,
          import_id: imp.id,
          property_id: propertyId,
          year: Number(l.year) || Number(year) || null,
          txn_date: l.date || null,
          description: l.description ? String(l.description).slice(0, 500) : null,
          amount: Math.abs(Number(l.amount) || 0),
          direction: l.direction === 'in' ? 'in' : 'out',
          line_hash: l.hash || null,
          disposition: l.disposition || 'unclassified',
          ignore_reason: l.disposition === 'ignored' ? (l.ignore_reason || null) : null,
          ref_kind: ref ? ref.kind : null,
          // entry_id covers the entity ledger (0077) and other income (0078);
          // lease_id covers a security deposit, which writes no row of its own and
          // whose whole record IS this pointer back to the lease it belongs to.
          ref_id: ref ? (ref.payment_id || ref.item_id || ref.entry_id || ref.lease_id || null) : null,
        };
      });
      await rows(supabase.from('statement_lines').insert(rowsToWrite));
    }
  } catch { /* the import stands; the audit row is not worth losing money over */ }

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
    summary: {
      paymentsCount, paymentsTotal, expensesCount, expensesTotal, crossProperty,
      entityOutCount, entityOutTotal, entityInCount, entityInTotal,
      incomeCount, incomeTotal, depositCount, depositTotal,
      capitalCount, capitalTotal,
      // The proof-of-completeness, returned so the results strip can state it at the
      // one moment it reassures: right after saving. Derived from the same array that
      // was just written, so it cannot claim more than the audit table holds.
      completeness: lineCompleteness(lines),
    },
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
  // Estimate writes are reversed LAST — after the import's payments + expenses are gone
  // — so the invoice + system-marked months re-price to the RESTORED prior estimate with
  // this import's deposits already removed.
  const estRecords = [];
  for (const a of imp.applied || []) {
    if (a.kind === 'estimate') {
      estRecords.push(a);
    } else if (a.kind === 'payment') {
      await deletePayment(a.payment_id);
    } else if (a.kind === 'cam') {
      await deleteCamLineItem(a.item_id, a.property_id, a.year);
    } else if (a.kind === 'tax_item') {
      await deleteTaxLineItem(a.item_id, a.property_id, a.year);
    } else if (a.kind === 'roof_item') {
      await deleteRoofLineItem(a.item_id, a.property_id, a.year);
    } else if (a.kind === 'tax' || a.kind === 'roof') {
      // Pre-0067 imports recorded taxes as a running total, and pre-0074 imports did
      // the same for the roof — reverse those exactly as they were written. Both
      // branches stay forever: an old statement's ↩ Undo has to keep working.
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
    } else if (a.kind === 'entity') {
      // Delete-if-exists, like a payment: a row George deleted by hand afterwards
      // must not break the rest of the undo. 0077 cascades on import_id as a
      // backstop, but this is explicit for the same reason statement_lines' delete
      // is — the demo mock has no foreign keys (mockClient.js:155).
      await deleteEntityLedgerEntry(a.entry_id);
    } else if (a.kind === 'income') {
      // Same reasoning as the entity row above: 0078 cascades, this is explicit
      // because the mock has no FKs and a cascade-only design would pass the whole
      // suite while orphaning rows live. (A deposit records no row at all — its
      // evidence is the statement line, which undo deletes wholesale.)
      await deleteOtherIncomeEntry(a.entry_id);
    } else if (a.kind === 'capital') {
      // Same explicit delete as the entity and income rows, for the same reason (0080
      // cascades on import_id; the demo mock has no FKs). Deleting the asset cascades
      // away any amortization line derived from it — but the kind it was billing into
      // has to be re-summed afterwards, or that total keeps the removed row's figure.
      const derived = await rows(
        supabase.from('cam_line_items').select('id,kind,year').eq('asset_id', a.asset_id)
      );
      // Deleted EXPLICITLY rather than left to the cascade — the demo mock has no
      // foreign keys, so a cascade-only design would pass the whole suite and orphan
      // amortization rows live, which is precisely the not() incident.
      for (const d of derived) await rows(supabase.from('cam_line_items').delete().eq('id', d.id));
      await deleteFixedAsset(a.asset_id);
      for (const d of derived) await syncTotalFor(a.property_id, d.year, d.kind);
    } else if (a.kind === 'deposit') {
      // Nothing to reverse: a deposit wrote no row, only the audit line's pointer at
      // its lease — and undo deletes every one of this import's lines wholesale. The
      // lease's stated deposit is untouched because the import never wrote it.
    } else if (a.kind === 'rule') {
      // Reverse the learning: a rule that overwrote a prior target restores it; a
      // brand-new rule is deleted. Best-effort — never blocks the rest of the undo.
      try {
        if (a.prior) await saveImportRule({ property_id: a.property_id, pattern: a.pattern, target_kind: a.prior.target_kind, lease_id: a.prior.lease_id, cam_label: a.prior.cam_label, account_hint: a.prior.account_hint ?? null });
        else if (a.rule_id) await deleteImportRule(a.rule_id);
      } catch { /* best-effort */ }
    }
  }
  // Restore each lease's prior estimate + resync the year back (payments are already gone).
  for (const a of estRecords) {
    try {
      await updateLease(a.lease_id, a.prior);
      await resyncYearBillingToEstimate(a.lease_id, a.property_id, a.year);
    } catch { /* best-effort — never blocks the rest of the undo */ }
  }
  // The audit rows go with the import: it didn't happen, so its lines didn't either,
  // and leaving them would assert money was recorded that no longer is. 0076 declares
  // ON DELETE CASCADE, but this delete is EXPLICIT on purpose — the demo mock has no
  // foreign keys, so relying on the database to do it would leave the suite passing
  // over behaviour that only works live. That is precisely the `not()` incident
  // (mockClient.js:155). The cascade stays as the backstop.
  await rows(supabase.from('statement_lines').delete().eq('import_id', imp.id));
  // Undo reverses the import's whole delta, and the statement copy is part of it —
  // there is no import left for it to belong to.
  await deleteDocumentsFor('statement_import', imp.id, [imp.storage_path]);
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

// The click-gated 🤖 helper (~1–2¢ per click): given the UNRECOGNIZED money-out
// lines and the owner's known bucket names, one small Haiku call suggests a bucket
// per line. Naming only — never amounts, never auto-booking: the review screen
// shows each suggestion unchecked and nothing writes without the user's say-so.
export async function suggestExpenseBuckets({ lines, buckets }) {
  return invokeFunction('suggest-buckets', { lines, buckets });
}

// The click-gated 🤖 helper for DEPOSITS nothing recognized (~1–2¢ per click): given
// the unmatched money-in lines and the owner's tenants, one small Haiku call suggests
// a tenant per line by NAME only (never amounts, never an invented id). The review
// screen lands each suggestion UNCHECKED with the AI chip — nothing books without the
// user's confirmation. Returns { suggestions: [{ index, lease_id, confidence }] }.
export async function suggestTenantMatches({ lines, tenants }) {
  return invokeFunction('suggest-tenant-match', { lines, tenants });
}

// The lease-stated estimated CAM & tax, read from the cached AI extraction on the
// lease's linked file (the 7/13 `expense_estimates` supplement stores it there as
// field-shaped { value, source_quote }). Used to PRE-FILL the estimate editor for
// a lease imported before estimates existed — the figure only starts billing when
// the landlord saves it. Returns { camTaxAnnual, roofAnnual, quote } or null.
export async function getLeaseStatedEstimate(leaseId) {
  const lease = await one(supabase.from('leases').select('lease_file_id').eq('id', leaseId).single());
  if (!lease?.lease_file_id) return null;
  const { data } = await supabase.from('lease_files').select('extraction_raw').eq('id', lease.lease_file_id).limit(1);
  const raw = data?.[0]?.extraction_raw;
  if (!raw) return null;
  const num = (f) => (f && f.value != null && Number(f.value) > 0 ? Number(f.value) : null);
  const cam = num(raw.est_cam_annual);
  const tax = num(raw.est_tax_annual);
  const roof = num(raw.est_roof_annual);
  if (cam == null && tax == null && roof == null) return null;
  return {
    camTaxAnnual: cam != null || tax != null ? (cam || 0) + (tax || 0) : null,
    roofAnnual: roof,
    quote: raw.est_cam_annual?.source_quote || raw.est_tax_annual?.source_quote || raw.est_roof_annual?.source_quote || null,
  };
}
