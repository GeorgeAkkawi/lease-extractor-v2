// In-memory mock of the subset of the Supabase client our app uses, so the UI is
// fully clickable in demo mode without any backend. Computes the v_property_totals
// and v_tenant_shares views the same way the SQL does (math stays in code).
import { seed, DEMO_USER, DEMO_PDF_B64 } from './store';
import { effectiveRent, occupancyStart, monthlyBases } from '../escalations';
import { monthlyScheduleForYear } from '../abatement';
import { billedComponents } from '../reconciliation';
import { fmtDate } from '../format';
// The same flag definitions the live edge functions use, so the demo's canned review
// carries the real titles/notes/severities rather than a second set that could drift.
import { LEASE_FLAG_DEFS } from '../../../supabase/functions/_shared/leaseFlags.js';

const db = seed();
let seq = 1000;
const newId = (p) => `${p}-${++seq}`;

const ok = (data) => ({ data, error: null });

function applyFilters(rows, filters) {
  return rows.filter((r) =>
    filters.every((f) => {
      const v = r[f.field];
      switch (f.op) {
        case 'eq': return v === f.value;
        case 'neq': return v !== f.value;
        case 'in': return f.value.includes(v);
        case 'gt': return v > f.value;
        case 'gte': return v >= f.value;
        case 'lt': return v < f.value;
        case 'lte': return v <= f.value;
        case 'is': return v == null;
        case 'not_is_null': return v != null;
        case 'ilike': return String(v ?? '').toLowerCase().includes(String(f.value).toLowerCase().replace(/%/g, ''));
        default: return true;
      }
    })
  );
}

// Stable order by one column, honouring the direction PostgREST was asked for.
// Nulls sort LAST in both directions (Postgres's own default for ASC is NULLS LAST;
// keeping them last in DESC too means a row with no timestamp never jumps to the top
// of a "newest first" list, which is the only place the difference shows).
function sortRows(rows, field, ascending = true) {
  const dir = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = a?.[field], vb = b?.[field];
    const na = va == null || va === '', nb = vb == null || vb === '';
    if (na && nb) return 0;
    if (na) return 1;
    if (nb) return -1;
    if (va === vb) return 0;
    return va > vb ? dir : -dir;
  });
}

// --- computed views ---------------------------------------------------------
function propertyTotals(propertyId, year) {
  const exp = db.expense_records.find((e) => e.property_id === propertyId && e.year === year);
  if (!exp) return null; // SQL view inner-joins expense_records
  const prop = db.properties.find((p) => p.id === propertyId);
  // Physical occupancy counts EVERY lease — an outdated (is_active === false) tenant
  // still occupies its space (and still owes rent) until the landlord removes it, so
  // total_sf / vacant / occupancy / revenue match the Leases page and v_property_totals
  // (0049). Billing rate cards below stay on the ACTIVE leased SF so the $/SF figures
  // keep matching the per-tenant bills (v_tenant_shares, 0042).
  const allLeases = db.leases.filter((l) => l.property_id === propertyId);
  const activeLeases = allLeases.filter((l) => l.is_active !== false);
  const totalSf = allLeases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const activeSf = activeLeases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const respSf = activeLeases.filter((l) => l.roof_responsible).reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const buildingSf = Number(prop?.building_sf) || totalSf;    // occupancy/vacant denominator (all leases)
  const billingDenom = Number(prop?.building_sf) || activeSf; // $/SF rate-card denominator (active leased SF)
  const revenue = allLeases.reduce((s, l) => s + effectiveRent(l, escFor(l.id), year), 0);
  const totalExpenses = Number(exp.taxes_total) + Number(exp.cam_total) + Number(exp.roof_total);
  const roofRecovered = billingDenom > 0 ? exp.roof_total * (respSf / billingDenom) : 0;
  return {
    property_id: propertyId, year,
    total_sf: totalSf, building_sf: buildingSf,
    vacant_sf: Math.max(0, buildingSf - totalSf),
    occupancy: buildingSf > 0 ? totalSf / buildingSf : null,
    total_revenue: revenue,
    taxes_total: exp.taxes_total, cam_total: exp.cam_total, roof_total: exp.roof_total,
    total_expenses: totalExpenses,
    noi: revenue - totalExpenses,
    tax_psf: billingDenom > 0 ? exp.taxes_total / billingDenom : null,
    cam_psf: billingDenom > 0 ? exp.cam_total / billingDenom : null,
    roof_psf_rate: activeSf > 0 ? exp.roof_total / activeSf : null,
    roof_recovered: roofRecovered,
    roof_unrecovered: exp.roof_total - roofRecovered,
  };
}

function tenantShares(propertyId, year) {
  const exp = db.expense_records.find((e) => e.property_id === propertyId && e.year === year);
  if (!exp) return [];
  const prop = db.properties.find((p) => p.id === propertyId);
  // Include ALL leases (incl. outdated/holdover, is_active === false) so a held-over
  // tenant still appears on the rent roll and keeps billing — mirrors v_tenant_shares
  // after migration 0058. The fallback denominator stays ACTIVE-only leased SF (like
  // the SQL `pt` subquery), so no existing tenant's CAM/tax/roof bill changes.
  const leases = db.leases.filter((l) => l.property_id === propertyId);
  const activeSf = leases.filter((l) => l.is_active !== false).reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  // Allocate over the WHOLE building's SF so the vacant share stays with the landlord.
  // Fall back to active leased SF until a building size is entered (mirrors v_tenant_shares).
  const denom = Number(prop?.building_sf) || activeSf;
  return leases.map((l) => {
    const perSf = denom > 0 ? l.square_footage / denom : 0;
    const share = l.share_override_pct != null ? l.share_override_pct : perSf;
    return {
      lease_id: l.id, property_id: propertyId, tenant_name: l.tenant_name,
      tenant_email: l.tenant_email ?? null, tenant_email_2: l.tenant_email_2 ?? null, tenant_contact_name: l.tenant_contact_name ?? null, year,
      square_footage: l.square_footage, roof_responsible: !!l.roof_responsible,
      base_rent: effectiveRent(l, escFor(l.id), year),
      share_pct: share, tax_amount: share * exp.taxes_total, cam_amount: share * exp.cam_total,
      roof_amt: l.roof_responsible ? exp.roof_total * perSf : 0,
      // lease_start appended to v_tenant_shares by 0061 — lets the tracker/roll prorate a mid-year start.
      lease_start: l.lease_start ?? null,
      is_active: l.is_active !== false, lease_termination_date: l.lease_termination_date ?? null, premises_address: l.premises_address ?? null,
      // Estimated additional rent (0060) — mirrors the three columns appended to v_tenant_shares.
      est_cam_annual: l.est_cam_annual ?? null, est_tax_annual: l.est_tax_annual ?? null, est_roof_annual: l.est_roof_annual ?? null,
      // est_confirmed_year appended by 0065 — drives the carried-over estimate note.
      est_confirmed_year: l.est_confirmed_year ?? null,
      // lease_type appended by 0073 — 'gross' carves the share OUT of the flat rent
      // instead of billing it on top. The share arithmetic above is unchanged, exactly
      // as in the SQL: only how it's SPENT differs.
      lease_type: l.lease_type ?? null,
    };
  });
}

const escFor = (leaseId) => db.rent_escalations.filter((e) => e.lease_id === leaseId);

// Mirrors the SQL v_invoice_balances view: derive amount_paid / balance /
// display_status from invoices + payments (math stays in code, like the others).
function invoiceBalances() {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  return (db.invoices || []).map((i) => {
    const paid = (db.payments || []).filter((p) => p.invoice_id === i.id).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const raw = (Number(i.total_amount) || 0) - paid;
    // Mirror the 0055 view: rounding dust within ±5¢ reads as settled (balance 0,
    // status paid) — a real balance beyond that is untouched.
    const balance = Math.abs(raw) <= 0.05 ? 0 : raw;
    let display_status;
    if (i.status === 'void') display_status = 'void';
    else if (i.status === 'draft') display_status = 'draft';
    else if (raw <= 0.05) display_status = 'paid';
    else if (paid > 0) display_status = 'partial';
    else if (i.due_date && new Date(i.due_date + 'T12:00:00') < today) display_status = 'overdue';
    else display_status = 'sent';
    return { ...i, amount_paid: paid, balance, display_status };
  });
}

function viewRows(table) {
  return table === 'v_property_totals' || table === 'v_tenant_shares';
}

// --- query builder ----------------------------------------------------------
class QB {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this._order = null;
    this._orderAsc = true;
    this._limit = null;
    this._op = 'select';
    this._payload = null;
    this._single = false;
    this._maybe = false;
  }
  select() { return this; }
  eq(field, value) { this.filters.push({ field, op: 'eq', value }); return this; }
  neq(field, value) { this.filters.push({ field, op: 'neq', value }); return this; }
  in(field, value) { this.filters.push({ field, op: 'in', value }); return this; }
  gt(field, value) { this.filters.push({ field, op: 'gt', value }); return this; }
  gte(field, value) { this.filters.push({ field, op: 'gte', value }); return this; }
  lt(field, value) { this.filters.push({ field, op: 'lt', value }); return this; }
  lte(field, value) { this.filters.push({ field, op: 'lte', value }); return this; }
  is(field) { this.filters.push({ field, op: 'is' }); return this; }
  // Mirror postgrest-js's real not(column, operator, value) signature. This used
  // to accept a single arg and assume "is not null", so a caller writing
  // .not('col') passed every test and then 400'd on live PostgREST (which builds
  // "col=not.undefined.undefined"). Throwing on a malformed call keeps that class
  // of live-only failure catchable in the suite.
  not(field, op, value) {
    if (op !== 'is' || value !== null) {
      throw new Error(`mock not(): expected .not('${field}', 'is', null) — postgrest-js takes (column, operator, value)`);
    }
    this.filters.push({ field, op: 'not_is_null' });
    return this;
  }
  ilike(field, value) { this.filters.push({ field, op: 'ilike', value }); return this; }
  filter(field, op, value) { this.filters.push({ field, op, value }); return this; }
  // Mirrors postgrest-js: order(column, { ascending }) — ascending by DEFAULT, and
  // descending when asked. This silently ignored the option until 2026-07-30, so any
  // `.order(x, { ascending: false })` list (archived policies, insurance requests, a
  // record's saved documents) came back in the OPPOSITE order in demo to live — the
  // same class of mock-vs-live divergence as the `not()` incident below.
  order(field, opts) { this._order = field; this._orderAsc = opts?.ascending !== false; return this; }
  limit(n) { this._limit = n; return this; }
  insert(payload) { this._op = 'insert'; this._payload = payload; return this; }
  update(payload) { this._op = 'update'; this._payload = payload; return this; }
  upsert(payload, opts) { this._op = 'upsert'; this._payload = payload; this._opts = opts; return this; }
  delete() { this._op = 'delete'; return this; }
  single() { this._single = true; return this; }
  maybeSingle() { this._maybe = true; return this; }

  _resolve() {
    // Computed AR view: build balance rows, then apply the generic filters/order.
    if (this.table === 'v_invoice_balances') {
      let list = applyFilters(invoiceBalances(), this.filters);
      if (this._order) list = sortRows(list, this._order, this._orderAsc);
      if (this._limit) list = list.slice(0, this._limit);
      return this._wrap(list);
    }

    // Views are read-only and computed. Supports a single property_id (eq), a set
    // of them (.in — used by the portfolio rollup on the dashboard), or all.
    if (viewRows(this.table)) {
      const pidFilter = this.filters.find((f) => f.field === 'property_id');
      const yr = this.filters.find((f) => f.field === 'year')?.value;
      let pids;
      if (pidFilter?.op === 'in') pids = pidFilter.value;
      else if (pidFilter) pids = [pidFilter.value];
      else pids = db.properties.map((p) => p.id);
      let out = [];
      for (const pid of pids) {
        if (this.table === 'v_property_totals') { const r = propertyTotals(pid, yr); if (r) out.push(r); }
        else out.push(...tenantShares(pid, yr));
      }
      // Apply any remaining filters (e.g. getTenantShare's .eq('lease_id', …)) + limit — the
      // property_id/year handled above are re-applied harmlessly. Without this a by-lease
      // view query returned every row and .limit(1) picked the wrong tenant.
      out = applyFilters(out, this.filters);
      if (this._limit) out = out.slice(0, this._limit);
      return this._wrap(out);
    }

    const list = db[this.table] || (db[this.table] = []);

    if (this._op === 'insert') {
      const items = Array.isArray(this._payload) ? this._payload : [this._payload];
      // Mirror the 0060 kind-scoped partial unique indexes (which replaced 0055's): at
      // most ONE live (non-void) invoice per (lease_id, year) PER KIND — the annual bill
      // and its year-end CAM/tax reconciliation coexist. Raise the same 23505 the real
      // DB does, so ensureInvoice / upsertYearInvoice / reconcileCamTax exercise their
      // duplicate-fallbacks in demo + tests.
      if (this.table === 'invoices') {
        const kindOf = (r) => r.kind ?? 'annual';
        const dup = items.find((it) => (it.status ?? 'sent') !== 'void' &&
          list.some((r) => r.status !== 'void' && kindOf(r) === kindOf(it) && r.lease_id === it.lease_id && Number(r.year) === Number(it.year)));
        if (dup) {
          return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "invoices_one_live_${(items[0]?.kind ?? 'annual') === 'reconciliation' ? 'recon' : 'annual'}_per_lease_year"` } };
        }
      }
      // Mirror the 0063 unique index: one import rule per (owner, property, pattern).
      if (this.table === 'import_rules') {
        const dup = items.find((it) =>
          list.some((r) => r.property_id === it.property_id && String(r.pattern).toLowerCase() === String(it.pattern).toLowerCase()));
        if (dup) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "import_rules_pattern_idx"' } };
        }
      }
      // Mirror the 0060 unique index: one CAM/tax reconciliation per (lease_id, year).
      if (this.table === 'cam_reconciliations') {
        const dup = items.find((it) => list.some((r) => r.lease_id === it.lease_id && Number(r.year) === Number(it.year)));
        if (dup) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "cam_reconciliations_lease_year_idx"' } };
        }
      }
      const created = items.map((it) => ({ id: newId(this.table.slice(0, 3)), created_at: new Date().toISOString(), ...it }));
      list.push(...created);
      return this._wrap(created);
    }
    if (this._op === 'upsert') {
      const it = this._payload;
      const keys = (this._opts?.onConflict || 'id').split(',');
      const idx = list.findIndex((r) => keys.every((k) => r[k] === it[k]));
      if (idx >= 0) { list[idx] = { ...list[idx], ...it }; return this._wrap([list[idx]]); }
      const created = { id: newId(this.table.slice(0, 3)), created_at: new Date().toISOString(), ...it };
      list.push(created);
      return this._wrap([created]);
    }
    if (this._op === 'update') {
      // Replace matched rows with NEW objects (don't mutate in place). React Query
      // uses structural sharing: an in-place mutation keeps the same object
      // reference, so a refetch looks "unchanged" and the UI never re-renders.
      const matched = [];
      db[this.table] = list.map((r) => {
        if (applyFilters([r], this.filters).length) {
          const updated = { ...r, ...this._payload, updated_at: new Date().toISOString() };
          matched.push(updated);
          return updated;
        }
        return r;
      });
      return this._wrap(matched);
    }
    if (this._op === 'delete') {
      const matched = applyFilters(list, this.filters);
      db[this.table] = list.filter((r) => !matched.includes(r));
      return this._wrap(matched);
    }

    // select
    let rows = applyFilters(list, this.filters);
    if (this._order) rows = sortRows(rows, this._order, this._orderAsc);
    if (this._limit) rows = rows.slice(0, this._limit);
    return this._wrap(rows);
  }

  _wrap(rows) {
    if (this._single) return ok(rows[0] ?? null);
    if (this._maybe) return ok(rows[0] ?? null);
    return ok(rows);
  }
  then(resolve) { resolve(this._resolve()); }
}

// --- auth / storage / functions --------------------------------------------
const auth = {
  async getUser() { return ok({ user: DEMO_USER }); },
  async getSession() { return ok({ session: { user: DEMO_USER } }); },
  onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
  async signInWithPassword() { return ok({ user: DEMO_USER }); },
  async signUp() { return ok({ user: DEMO_USER }); },
  async signOut() { return ok({}); },
  // Password reset / change is inactive in the demo (the UI says so); the stubs keep
  // the buttons from throwing if a caller reaches them.
  async resetPasswordForEmail() { return ok({}); },
  async updateUser() { return ok({ user: DEMO_USER }); },
};

const storage = {
  from() {
    return {
      // Each upload gets its own path, so the demo's document lists can show more
      // than one version of a file (a single constant path would collapse them and
      // hide the very behaviour the list exists to demonstrate).
      async upload(path) { return ok({ path: path || 'demo/upload' }); },
      async download() { return ok(new Blob([])); },
      // A signature PNG gets a 1×1 transparent placeholder and everything else gets the
      // seeded lease PDF as a data: URL — so the countersign screen can actually render the
      // document and show the tenant's mark on it, which is the whole point of that screen.
      // '#demo-document' stays the answer for anything opened in a new tab, where the demo
      // deliberately has no real file to hand over.
      async createSignedUrl(path) {
        if (String(path || '').endsWith('.png')) {
          return ok({ signedUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
        }
        if (/\.pdf$/i.test(String(path || ''))) {
          return ok({ signedUrl: `data:application/pdf;base64,${DEMO_PDF_B64}` });
        }
        return ok({ signedUrl: '#demo-document' });
      },
      // Deleting a copy is a real action in the demo — the registry row goes either
      // way, but without this stub the mock would throw where live code succeeds.
      async remove() { return ok([]); },
    };
  },
};

const functions = {
  async invoke(name, { body } = {}) {
    if (name === 'extract-lease') {
      return ok({
        extraction: {
          tenant_name: { value: 'Summit Fitness', confidence: 0.96, source_quote: 'Tenant: Summit Fitness LLC', page: 1 },
          square_footage: { value: 4200, confidence: 0.91, source_quote: 'Premises of approximately 4,200 sq ft', page: 1 },
          base_rent: { value: 96000, confidence: 0.88, source_quote: 'Annual base rent of $96,000', page: 2 },
          lease_start: { value: '2025-03-01', confidence: 0.9, source_quote: 'commencing March 1, 2025', page: 2 },
          lease_termination_date: { value: '2030-02-28', confidence: 0.84, source_quote: 'expiring February 28, 2030', page: 2 },
          lease_terms: { value: 'NNN; 3% annual escalations.', confidence: 0.7, source_quote: 'triple net, escalating 3% annually', page: 3 },
          escalations: [{ effective_date: '2026-03-01', escalation_type: 'percent', escalation_value: 3, new_base_rent: null }],
          renewal_options: [{ option_label: 'Option 1', notice_by_date: '2029-08-31', term_months: 60, new_rent: null, notes: 'FMV' }],
          // Stated estimated CAM (annualized in code from "$3.50/SF per annum" × 4,200 SF)
          // — prefills the review form's Est. CAM field, like the live extractor.
          est_cam_annual: { value: 14700, confidence: 0.9, source_quote: 'estimated CAM charges of $3.50 per square foot per annum', page: null },
          // The red-flag review the analyst answers on the same read, in the shape the
          // FLAGS line parses to. The canned lease below genuinely omits a guaranty,
          // a late fee and a holdover premium, and prices its option at FMV — so these
          // four are what a real read of it would return.
          ai_review: {
            flags: [
              { key: 'no_personal_guarantee', severity: 'high', title: 'No personal guarantee', note: 'The lease is signed by the business only. If the entity folds or stops paying, there is no individual to pursue for the balance — a personal guarantee from an owner is the usual protection.', quote: 'No guaranty clause appears in the lease.' },
              { key: 'no_late_fee', severity: 'medium', title: 'No late fee or interest on late rent', note: 'Nothing in the lease penalises paying late, so there is little cost to the tenant in doing so.', quote: 'The lease does not state a late fee or interest on overdue rent.' },
              { key: 'no_holdover_premium', severity: 'medium', title: 'No holdover premium', note: 'If the tenant stays past the term, the rent does not step up. A holdover clause (commonly 150–200% of base rent) is what gets the space back or gets it paid for.', quote: 'Holdover is not addressed.' },
            ],
            model: 'claude-sonnet-4-6',
            reviewed_at: new Date().toISOString(),
            source: 'extract_lease',
          },
        },
        // One-time plain-text copy cached on the lease for the AI assistant.
        full_text: [
          'COMMERCIAL LEASE AGREEMENT',
          'Tenant: Summit Fitness LLC. Premises: Suite 210, approximately 4,200 rentable square feet.',
          'Base Rent: $96,000.00 per annum, payable in equal monthly installments of $8,000.00.',
          'Term: Five (5) years commencing March 1, 2025 and expiring February 28, 2030.',
          'Annual Adjustment: Base Rent shall increase by three percent (3%) on each anniversary, first effective March 1, 2026.',
          'Lease Type: Triple net (NNN). Tenant pays its pro-rata share of property taxes, CAM, and insurance,',
          'including estimated CAM charges of $3.50 per square foot per annum, reconciled annually.',
          'Renewal: Tenant shall have one (1) option to renew for five (5) years at fair market value upon written notice no later than August 31, 2029.',
          'Maintenance: Landlord maintains roof and structure; Tenant maintains the interior of the Premises.',
        ].join('\n'),
      });
    }
    if (name === 'ask-lease') {
      return ok(demoAskLease(body));
    }
    if (name === 'ask-doc') {
      return ok(demoAskDoc(body));
    }
    if (name === 'ask-portfolio') {
      return ok(demoAskPortfolio(body));
    }
    if (name === 'ask-leases') {
      return ok(demoAskLeases(body));
    }
    if (name === 'extract-insurance') {
      return ok(demoExtractInsurance());
    }
    if (name === 'extract-annual-report') {
      return ok(demoExtractAnnualReport());
    }
    if (name === 'extract-contract') {
      return ok(demoExtractContract(body));
    }
    if (name === 'extract-closing-statement') {
      return ok(demoExtractClosingStatement());
    }
    if (name === 'extract-addendum') {
      return ok(demoExtractAddendum());
    }
    if (name === 'draft-invoice') {
      const facts = demoInvoiceFacts(body);
      return ok({ facts, from: facts.business?.contact_email ?? null });
    }
    if (name === 'send-tenant-email') {
      // The demo sandbox never emails anyone — pretend it went out.
      return ok({ id: 'demo-email' });
    }
    if (name === 'draft-tenant-email') {
      return ok(demoDraftTenantEmail(body));
    }
    if (name === 'draft-announcement') {
      return ok(demoDraftAnnouncement(body));
    }
    if (name === 'send-announcement') {
      // The demo sandbox never emails anyone — pretend every copy went out. Mirrors the
      // live shape ({ sent, failed }) so the modal's per-recipient result line is exercised.
      const to = (body?.recipients || []).map((r) => (typeof r === 'string' ? r : r?.to)).filter(Boolean);
      return ok({ sent: to.map((addr) => ({ to: addr, id: 'demo-email' })), failed: [] });
    }
    // ---- E-signature ------------------------------------------------------
    // The sandbox never emails anyone and never mints a real token. It DOES walk the
    // envelope through its real states, because the states are the feature: sending
    // creates a 'sent' row, the signing page moves it to 'signed', and countersigning
    // moves it to 'executed'. A stub that only returned ok() would leave the strip in the
    // Addendums card, the countersign dialog and the alert completely unexercised.
    if (name === 'send-for-signature') {
      const nowIso = new Date().toISOString();
      if (body?.resend_envelope_id) {
        const env = (db.signature_envelopes || []).find((e) => e.id === body.resend_envelope_id);
        if (env) { env.status = 'sent'; env.expires_at = body.expires_at; env.sent_at = nowIso; }
        return ok({ envelope_id: body.resend_envelope_id, sign_url: demoSignUrl(body.resend_envelope_id), emailed: true });
      }
      const id = `env-${Math.random().toString(36).slice(2, 10)}`;
      (db.signature_envelopes ||= []).push({
        id, owner_id: DEMO_USER.id, lease_id: body?.lease_id, property_id: body?.property_id,
        renewal_option_id: body?.renewal_option_id ?? null, purpose: body?.purpose || 'other',
        title: body?.title || 'Document', storage_path: body?.storage_path || 'demo/doc.pdf',
        filename: body?.filename ?? null, doc_sha256: 'demo0000000000000000000000000000000000000000000000000000000000',
        message: body?.message ?? null, status: 'sent', expires_at: body?.expires_at,
        sent_at: nowIso, signed_at: null, countersigned_at: null, executed_at: null,
        applied_at: null, executed_path: null, certificate_path: null,
        created_at: nowIso, updated_at: nowIso,
      });
      (db.envelope_signers ||= []).push(
        { id: `sgn-${id}-t`, owner_id: DEMO_USER.id, envelope_id: id, role: 'tenant',
          name: body?.signer_name || 'Tenant', email: body?.signer_email || null,
          // The demo stores the "token" in the clear because there is no security boundary
          // to protect in an in-memory sandbox. LIVE STORES ONLY sha256(token) — see 0085.
          token_hash: id, signed_at: null, typed_name: null, signature_path: null,
          consent_at: null, ip: null, user_agent: null, created_at: nowIso },
        { id: `sgn-${id}-l`, owner_id: DEMO_USER.id, envelope_id: id, role: 'landlord',
          name: body?.landlord_name || 'Landlord', email: body?.reply_to || null,
          token_hash: null, created_at: nowIso },
      );
      (db.envelope_events ||= []).push(
        { id: evtId(), owner_id: DEMO_USER.id, envelope_id: id, kind: 'created', actor: 'landlord', at: nowIso },
        { id: evtId(), owner_id: DEMO_USER.id, envelope_id: id, kind: 'sent', actor: 'landlord', at: nowIso },
      );
      return ok({ envelope_id: id, sign_url: demoSignUrl(id), emailed: true });
    }
    if (name === 'sign-envelope') {
      return demoSignEnvelope(body);
    }
    if (name === 'countersign-envelope') {
      const env = (db.signature_envelopes || []).find((e) => e.id === body?.envelope_id);
      if (!env) return { data: null, error: { message: 'That document no longer exists.' } };
      if (env.status !== 'signed') return { data: null, error: { message: 'The tenant hasn’t signed this yet.' } };
      const nowIso = new Date().toISOString();
      const path = `executed/${env.id}/demo-signed.pdf`;
      Object.assign(env, {
        status: 'executed', countersigned_at: nowIso, executed_at: nowIso,
        executed_path: path, certificate_path: path, updated_at: nowIso,
      });
      const landlord = (db.envelope_signers || []).find((s) => s.envelope_id === env.id && s.role === 'landlord');
      if (landlord) {
        Object.assign(landlord, {
          typed_name: body?.typed_name || null, signed_at: nowIso, consent_at: nowIso,
          signature_path: `signatures/${env.id}/landlord-demo.png`,
          ...demoPlacement(body?.placement),
        });
      }
      (db.envelope_events ||= []).push(
        { id: evtId(), owner_id: DEMO_USER.id, envelope_id: env.id, kind: 'countersigned', actor: 'landlord', at: nowIso },
        { id: evtId(), owner_id: DEMO_USER.id, envelope_id: env.id, kind: 'executed', actor: 'system', at: nowIso },
      );
      // No PDF is built in the sandbox — pdf-lib is a Deno-side dependency of the edge
      // function and never ships in the browser bundle.
      return ok({ ok: true, executed_path: path, stamped: true });
    }
    if (name === 'review-lease') {
      return ok(demoReviewLease(body));
    }
    if (name === 'cache-lease-text') {
      // The seeded leases all carry lease_text, so the sweep never actually calls this
      // in demo — it's here so a seed change (or a hand-cleared lease_text) degrades to
      // a sensible answer instead of an unhandled-function error.
      const lease = (db.leases || []).find((l) => l.id === body?.lease_id);
      const text = String(lease?.lease_text || '').trim();
      if (text.length >= 500) return ok({ skipped: 'already_cached', length: text.length });
      return ok({ length: 0, source: 'transcription', tenant_name: lease?.tenant_name || null });
    }
    if (name === 'extract-bank-statement') {
      // Canned PDF-lane transcription over the seeded tenants: clean deposits, a
      // garbled payee (the "always match" rule demo), tax/CAM withdrawals — two of
      // which land in named BUCKETS (Waste removal / Snow removal) — a mortgage
      // line the matcher auto-ignores, and an unrecognized Home Depot line that
      // demos the 🤖 Suggest-buckets button. Amounts follow the seed's figures.
      // Real statements print most lines as a bare "03/09" and state the year once,
      // in the period header — the canned rows mirror that (a tidy full-year date on
      // every line is what hid the year-resolution bug from the whole suite).
      const y = new Date().getFullYear();
      return ok({
        period_start: `03/01/${y}`,
        period_end: `03/31/${y}`,
        transactions: [
          { date: `03/03/${y}`, description: 'CHECK 1044 CITY DENTAL PC', amount: '4,208.33', direction: 'in', balance: '' },
          { date: '03/05', description: 'ACH DEPOSIT BRIGHT COFFEE CO', amount: '6,508.33', direction: 'in', balance: '' },
          { date: '03/09', description: 'MOBILE DEPOSIT J PAK 2211', amount: '10,416.67', direction: 'in', balance: '' },
          { date: `03/12/${y}`, description: 'COOK COUNTY TREASURER PROP TAX', amount: '3,100.00', direction: 'out', balance: '' },
          { date: `03/15/${y}`, description: 'GREENLEAF LANDSCAPING INV 2288', amount: '450.00', direction: 'out', balance: '' },
          { date: `03/17/${y}`, description: 'WASTE MGMT GARBAGE SVC 55021', amount: '380.00', direction: 'out', balance: '' },
          { date: `03/19/${y}`, description: 'ARCTIC SNOW PLOWING FEB SVC', amount: '600.00', direction: 'out', balance: '' },
          { date: `03/22/${y}`, description: 'HOME DEPOT PURCHASE 8841', amount: '212.48', direction: 'out', balance: '' },
          { date: `03/28/${y}`, description: 'CHASE MORTGAGE PMT 0099', amount: '5,200.00', direction: 'out', balance: '' },
        ],
        lines_read: 9,
      });
    }
    if (name === 'suggest-buckets') {
      // Canned 🤖 bucket suggestions ($0 in the demo): name each passed line from
      // its description, echoing the caller's index — suggestion-only, unchecked.
      const lines = Array.isArray(body?.lines) ? body.lines : [];
      return ok({
        suggestions: lines.map((l) => {
          const d = String(l?.description || '').toUpperCase();
          if (/DEPOT|HARDWARE|LUMBER|SUPPLY/.test(d)) return { index: l.index, bucket: 'Repairs & supplies', billable: true, confidence: 'medium' };
          if (/LEGAL|ATTORNEY|CPA|ACCOUNT/.test(d)) return { index: l.index, bucket: 'Owner legal fees', billable: false, confidence: 'medium' };
          return { index: l.index, bucket: 'Maintenance', billable: true, confidence: 'low' };
        }),
      });
    }
    if (name === 'suggest-tenant-match') {
      // Canned 🤖 tenant suggestions ($0 in the demo): match each passed deposit line
      // against the seeded tenants by NAME — the tenant's business name AND its
      // contact/owner name from the demo seed — so "MOBILE DEPOSIT J PAK 2211"
      // resolves to Northwind Books (run by Jordan Pak). Suggestion-only, unchecked.
      const lines = Array.isArray(body?.lines) ? body.lines : [];
      const tenants = Array.isArray(body?.tenants) ? body.tenants : [];
      const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
      const NOISE = new Set(['LLC', 'INC', 'CO', 'CORP', 'THE', 'OF', 'AND', 'GROUP', 'COMPANY', 'BOOKS', 'STUDIO', 'YOGA', 'COFFEE', 'DENTAL']);
      const toks = (s) => norm(s).split(' ').filter((t) => t.length >= 3 && !NOISE.has(t));
      return ok({
        suggestions: lines.map((l) => {
          const d = ` ${norm(l?.description)} `;
          let best = '';
          for (const t of tenants) {
            const contact = db.leases.find((x) => x.id === t.lease_id)?.tenant_contact_name;
            const names = [...toks(t.tenant_name), ...toks(contact)];
            if (names.some((tok) => d.includes(` ${tok} `))) { best = t.lease_id; break; }
          }
          return { index: l?.index, lease_id: best, confidence: best ? 'medium' : 'low' };
        }),
      });
    }
    if (name === 'trends-narrative') {
      return ok({ narrative: 'Revenue held steady year over year while taxes rose ~14% and CAM ~12%, lifting the tax PSF from $4.40 to $5.00 and CAM PSF from $3.20 to $3.60. The new roof expense this year is tracked separately and excluded from PSF.' });
    }
    return ok({});
  },
};

// Produces the invoice "facts" the shared template (src/lib/invoiceTemplate.js)
// renders. The landlord maintains the tax figure based on the prior year's
// assessment (taxes bill in arrears); it's billed on the current-year invoice but
// labeled with the lagging tax year. A roof-responsible tenant's roof share is a
// separate line. The frontend formats the figures.
function demoInvoiceFacts(body) {
  const propId = findLeaseProp(body?.lease_id);
  const year = Number(body?.year);
  const share = (tenantShares(propId, year) || []).find((s) => s.lease_id === body?.lease_id);
  const lease = db.leases.find((l) => l.id === body?.lease_id);
  const prop = db.properties.find((p) => p.id === propId);
  const corp = prop ? db.corporations.find((c) => c.id === prop.corporation_id) : null;
  const business = corp
    ? { company_name: corp.name, address: corp.address, contact_email: corp.contact_email, contact_phone: corp.contact_phone }
    : null;
  const now = new Date();
  const due = new Date(now.getTime() + 30 * 86400000);
  // Estimate-preferred per component (0060) — mirrors the real draft-invoice edge fn:
  // a typed estimate bills; a blank one falls back to the actual share. On a GROSS
  // lease (0073) the flat rent already includes taxes & CAM, so the share is carved
  // OUT of it below rather than added on top. Read from the shared pure helper (the
  // leaseFlags precedent) so the demo can't drift from the billing math it mimics.
  const billed = share ? billedComponents(share) : { cam: 0, tax: 0, roof: 0, gross: false };
  const cam = billed.cam;
  const tax = billed.tax;
  const roof = billed.roof; // separate roof line
  // Term-aware proration (mirrors the real draft-invoice edge fn): a mid-year lease start
  // bills only the months it covers. Reuse the same pure helpers the app runtime uses.
  const escs = escFor(body?.lease_id);
  const abatements = (db.rent_abatements || []).filter((a) => a.lease_id === body?.lease_id);
  const grossBase = share ? share.base_rent : (lease?.base_rent || 0);
  const occ = occupancyStart({ lease_start: share?.lease_start ?? lease?.lease_start }, escs);
  const bases = monthlyBases(escs, grossBase, year);
  const sched = monthlyScheduleForYear({ year, annualBaseRent: grossBase, otherAnnual: billed.gross ? 0 : cam + tax + roof, abatements, occupancyStartIso: occ, monthlyBases: bases });
  const months = Object.values(sched);
  const inTerm = months.filter((c) => !c.outsideTerm).length;
  const ratio = inTerm / 12;
  // Prorated gross base over in-term months (sum of that month's base rate ÷ 12).
  let proratedBaseGross = 0;
  let proratedAbatement = 0;
  for (let m = 1; m <= 12; m++) {
    if (sched[m].outsideTerm) continue;
    proratedBaseGross += (bases[m - 1] != null ? Number(bases[m - 1]) : grossBase) / 12;
    proratedAbatement += Number(sched[m].credit) || 0;
  }
  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  return {
    business,
    tenant: share?.tenant_name || lease?.tenant_name || 'Tenant',
    tenant_contact_name: share?.tenant_contact_name || lease?.tenant_contact_name || null,
    tenant_email: share?.tenant_email || lease?.tenant_email || null,
    property: prop?.name || '',
    property_address: prop?.address || '',
    year,
    tax_year: year - 1, // taxes lag a year — used for the tax line label + note
    square_footage: share?.square_footage || lease?.square_footage || 0,
    // Gross: the components come OUT of the prorated flat rent, so they still sum to
    // the flat figure the tenant pays.
    base_rent_annual: billed.gross
      ? r2(proratedBaseGross - r2(cam * ratio) - r2(tax * ratio) - r2(roof * ratio))
      : r2(proratedBaseGross),
    cam_annual: r2(cam * ratio),
    tax_annual: r2(tax * ratio),
    roof_annual: r2(roof * ratio),
    abatement_annual: r2(proratedAbatement),
    occupancy_start: occ,
    months_billed: inTerm,
    lease_type: share?.lease_type ?? lease?.lease_type ?? null,
    estimated: billed.gross ? { cam: false, tax: false, roof: false } : {
      cam: share?.est_cam_annual != null,
      tax: share?.est_tax_annual != null,
      roof: !!share?.roof_responsible && share?.est_roof_annual != null,
    },
    today: now.toISOString().slice(0, 10),
    due: due.toISOString().slice(0, 10),
  };
}

function findLeaseProp(leaseId) {
  return db.leases.find((l) => l.id === leaseId)?.property_id;
}

// Demo stand-in for the generic ask-doc Edge Function: keyword-routes a question
// to a line from the provided document text (insurance/contract aware).
function demoAskDoc(body) {
  const doc = (body?.text || '').trim();
  const q = (body?.question || '').toLowerCase();
  const tail = '\n\n(Demo mode gives canned answers. Connected to your API key, the AI reads the full document and answers precisely.)';
  if (!doc) return { answer: 'No document text is on file yet. Add the document above, then I can answer questions about it.' };
  const line = (re) => doc.split('\n').find((ln) => re.test(ln));
  if (/(additional insured|additionally insured|named insured)/.test(q)) return { answer: (line(/additional insured/i) || 'The document does not appear to mention an additional-insured endorsement.') + tail };
  if (/(deductible)/.test(q)) return { answer: (line(/deductible/i) || 'No deductible is stated in the document.') + tail };
  if (/(coverage|limit|insured up to|how much|amount|sum insured)/.test(q)) return { answer: (line(/coverage|limit|aggregate|\$[\d,]/i) || 'See the document for coverage limits.') + tail };
  if (/(cancel|terminat|notice)/.test(q)) return { answer: (line(/cancel|terminat|notice/i) || 'See the document for cancellation/termination terms.') + tail };
  if (/(vendor|provider|contractor|who|company)/.test(q)) return { answer: (line(/vendor|provider|contractor|by and between|company/i) || 'See the document for the provider.') + tail };
  if (/(expir|renew|term|effective|start|end|date)/.test(q)) return { answer: (line(/expir|effective|term|through|date/i) || 'See the document for term/effective dates.') + tail };
  if (/(cost|price|fee|amount|pay|rate)/.test(q)) return { answer: (line(/\$[\d,]|fee|cost|price|per (month|year|annum)|rate/i) || 'See the document for pricing.') + tail };
  const snippet = doc.split('\n').filter(Boolean).slice(0, 3).join(' ');
  return { answer: `From the document: ${snippet}` + tail };
}

// Demo stand-in for extract-contract: guesses the type from the contract name and
// returns plausible key-terms + a sample contract transcription (the user edits).
function demoExtractContract(body) {
  const name = (body?.name || '').toLowerCase();
  const y = new Date().getFullYear();
  let service_type = 'other', vendor = 'Evergreen Facility Services', amount = 10000, services = 'general facility services';
  if (/snow|ice|plow/.test(name)) { service_type = 'snow_removal'; vendor = 'Arctic Snow Services'; amount = 8000; services = 'plowing and salting of the lot and walkways'; }
  else if (/landscap|lawn|garden|grounds/.test(name)) { service_type = 'landscaping'; vendor = 'GreenScape Inc.'; amount = 12000; services = 'weekly mowing, seasonal planting, and leaf removal'; }
  else if (/secur|guard|patrol|alarm/.test(name)) { service_type = 'security'; vendor = 'SecureCo'; amount = 6000; services = 'nightly mobile patrol and alarm response'; }
  return {
    fields: { service_type, vendor, amount, frequency: 'annual', start_date: `${y}-01-01`, end_date: `${y}-12-31` },
    full_text: [
      'SERVICE AGREEMENT',
      `By and between Acme Holdings LLC (owner) and ${vendor} (contractor).`,
      `Services: ${services}.`,
      `Fee: $${amount.toLocaleString('en-US')} per year, billed monthly.`,
      `Term: January 1, ${y} to December 31, ${y}. Auto-renews annually unless cancelled with 30 days written notice.`,
    ].join('\n'),
  };
}

// Demo stand-in for extract-addendum: a sample term-extension rider with a new
// rent, plus a transcription (the user reviews/edits before applying).
function demoExtractAddendum() {
  const y = new Date().getFullYear();
  const newEnd = `${y + 5}-12-31`;
  return {
    fields: {
      label: 'First Amendment',
      amendment_date: `${y}-01-01`,
      new_termination_date: newEnd,
      new_base_rent: 132000,
      new_base_rent_effective_date: `${y}-01-01`,
      escalations: [{ effective_date: `${y + 2}-01-01`, escalation_type: 'percent', escalation_value: 3, new_base_rent: null }],
      renewal_options: [],
      // A rider almost always re-states what the tenant pays toward taxes and CAM,
      // usually as a monthly "Monthly Figures" block. The extractor reads the raw
      // $1,500.00 and annualizes it in code → $18,000.00 exactly.
      est_cam_annual: 18000,
      est_tax_annual: null,
      est_roof_annual: null,
      est_quote: 'Real Estate Taxes & CAM: $1,500.00',
      // The rider also RE-SIZES the premises — read all along for the $/SF arithmetic and
      // then thrown away, so a tenant's CAM and tax share went on billing the old size. It
      // is the numerator of that split, so the review screen asks before it re-splits.
      // A surrender rather than an expansion on purpose: the seeded building is fully let,
      // so an expansion would over-let it (shares summing past 100%) and read as a bug.
      // This fits, and puts the vacant-space row on the Financials breakdown too.
      new_square_footage: 1600,
      square_footage_quote: 'Tenant surrenders the rear storage area, reducing the Premises to 1,600 rentable square feet',
      // The rider recites the rent clause it replaces — the defining habit of the genre,
      // and the shape that used to arrive as a second live rent period. Recognized and
      // reported, never applied.
      superseded_rent: [{ effective_date: `${y - 3}-01-01`, amount: 10000, period: 'per_month', annual: 120000 }],
      analysis_brief: [
        '• WHAT THIS DOCUMENT CHANGES vs WHAT IT MERELY QUOTES — Paragraph 2 recites the prior',
        `  rent clause ("$10,000.00 per month beginning January 1, ${y - 3}"); that is the OLD rent and`,
        `  does not govern. The operative rent is $11,000.00 per month effective January 1, ${y}.`,
        `• TERM — extended through December 31, ${y + 5} (a printed date; no length stated).`,
        `• RENT — $11,000.00/month from January 1, ${y}, rising three percent (3%) on January 1, ${y + 2}.`,
        '• RENEWAL / EXTENSION OPTIONS THIS RIDER GRANTS — none.',
        '• TENANT — not assigned; the tenant is unchanged.',
        '• PREMISES — reduced to 1,600 rentable square feet; the rear storage area is surrendered (Paragraph 5).',
        '• OTHER — Real Estate Taxes & CAM stated at $1,500.00 per month.',
        '',
        'VERDICTS: rent_change=yes; superseded_quote=yes; term_extension=yes; extension_months=none; ' +
          `new_end_date=${newEnd}; renewal_options=no; assignment=no; abatement=no; expense_estimate=yes`,
      ].join('\n'),
      summary: `Extends the term through ${fmtDate(newEnd)} at $132,000/yr with a 3% bump in ${y + 2}.`,
    },
    full_text: [
      'FIRST AMENDMENT TO COMMERCIAL LEASE',
      `This amendment, dated January 1, ${y}, modifies the lease between the parties.`,
      `1. Term. The Lease term is extended through December 31, ${y + 5}.`,
      `2. Base Rent. Paragraph 4 of the Lease currently reads "Monthly Base Rent shall be $10,000.00`,
      `   beginning January 1, ${y - 3}." This will be changed to $11,000.00 per month effective`,
      `   January 1, ${y} (annual base rent $132,000.00).`,
      `3. Escalation. Base rent increases three percent (3%) on January 1, ${y + 2}.`,
      '4. Real Estate Taxes and Additional Rent. As described in the first Addendum.',
      '5. Premises. Tenant surrenders the rear storage area, reducing the Premises to',
      '   1,600 rentable square feet.',
      '',
      'Monthly Figures',
      '        Base Rent:                    $11,000.00',
      '        Real Estate Taxes & CAM:       $1,500.00',
      '        ------------------------------------------',
      '        Total                         $12,500.00 Monthly rent',
      '',
      'All other terms of the Lease remain in full force and effect.',
    ].join('\n'),
  };
}

// Demo stand-in for extract-insurance: canned key-facts + a sample COI transcription.
function demoExtractInsurance() {
  const nextYear = new Date().getFullYear() + 1;
  return {
    fields: { insurer: 'Granite Mutual Insurance', coverage_amount: 2000000, expiry_date: `${nextYear}-03-31`, additional_insured: true },
    full_text: [
      'CERTIFICATE OF LIABILITY INSURANCE',
      'Insurer: Granite Mutual Insurance Company.',
      'Commercial General Liability — each occurrence limit: $2,000,000; general aggregate: $4,000,000.',
      'Deductible: $5,000 per occurrence.',
      `Policy period: April 1, ${nextYear - 1} to March 31, ${nextYear}.`,
      'Additional insured: the landlord is named as additional insured per the lease (endorsement CG 20 11).',
    ].join('\n'),
  };
}

// Demo stand-in for extract-annual-report: returns a canned filing deadline (~2
// months out) so the upload/paste path pre-fills a date to review.
function demoExtractAnnualReport() {
  const dt = new Date();
  dt.setDate(dt.getDate() + 60);
  return { fields: { due_date: dt.toISOString().slice(0, 10) } };
}

// Demo stand-in for extract-closing-statement: a realistic ALTA settlement statement
// with the shape that matters — a purchase price, a handful of capitalizable charges,
// loan points that are NOT part of the building, and several lines that are neither.
// Land is deliberately absent, which is the honest common case: a settlement statement
// almost never states the split, so the building arrives blocked and asks for it.
function demoExtractClosingStatement() {
  return {
    fields: {
      purchase_price: 1450000,
      closing_date: '2019-06-14',
      land_value: null,
      land_value_quote: null,
      costs: [
        { label: "Owner's title insurance premium", amount: 4350, treatment: 'acquisition' },
        { label: 'Settlement / closing fee', amount: 1200, treatment: 'acquisition' },
        { label: 'Recording fees — deed', amount: 186, treatment: 'acquisition' },
        { label: 'State transfer tax', amount: 2175, treatment: 'acquisition' },
        { label: 'ALTA survey', amount: 2800, treatment: 'acquisition' },
        { label: 'Loan origination fee (1.0%)', amount: 10150, treatment: 'loan' },
        { label: "Lender's title policy", amount: 1425, treatment: 'loan' },
        { label: 'County property taxes 01/01–06/14 (seller credit)', amount: 8940, treatment: 'expense' },
        { label: 'Prepaid hazard insurance — 12 months', amount: 6300, treatment: 'expense' },
        { label: 'Tenant security deposits transferred', amount: 21500, treatment: 'not_basis' },
        { label: 'Prorated June rent credited by seller', amount: 9416.67, treatment: 'not_basis' },
        { label: 'Lender tax & insurance escrow — initial funding', amount: 4550, treatment: 'not_basis' },
      ],
    },
  };
}

// Demo stand-in for the ask-lease Edge Function: keyword-routes the question to a
// plausible answer drawn from the seeded lease data, so the assistant UX works
// with no backend. Connected to a real API key, the function reads the cached
// full lease text and answers precisely.
function demoAskLease(body) {
  const lease = db.leases.find((l) => l.id === body?.lease_id);
  const doc = ((lease && lease.lease_text) || body?.lease_text || '').trim();
  const q = (body?.question || '').toLowerCase();
  const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US');
  const tail = '\n\n(Demo mode gives canned answers. Connected to your API key, the AI reads the full lease text and answers precisely.)';

  if (!doc && !(lease && lease.lease_terms)) {
    return { answer: "There's no lease document on file for this tenant yet. Upload or paste the lease text on this page, then I can answer questions about it." };
  }

  // Archived/text-only lease (no live record): answer straight from the document.
  if (!lease) {
    const line = (re) => doc.split('\n').find((ln) => re.test(ln));
    if (/(rent|how much|price|cost)/.test(q)) return { answer: (line(/rent/i) || 'See the lease document for rent details.') + tail };
    if (/(renew|extend|option)/.test(q)) return { answer: (line(/renew/i) || 'No renewal option is mentioned in this lease.') + tail };
    if (/(term|expire|end|start|commence|date)/.test(q)) return { answer: (line(/term|expir|commenc/i) || 'See the lease document for term dates.') + tail };
    const snippet = doc.split('\n').filter(Boolean).slice(1, 4).join(' ');
    return { answer: `From the lease: ${snippet}` + tail };
  }

  if (/(renew|extension|extend|option)/.test(q)) {
    const ren = db.renewal_options.find((r) => r.lease_id === lease.id);
    if (lease.no_renewal_option) return { answer: 'This lease has been marked as having no renewal option. The term ends on its stated expiration date with no extension right.' + tail };
    if (ren) return { answer: `Yes — ${ren.option_label || 'a renewal option'} allows extending the term by ${ren.term_months || '—'} months${ren.new_rent ? ` at ${usd(ren.new_rent)}/yr` : ' (rent per the lease)'}. Written notice is due by ${ren.notice_by_date || 'the date stated in the lease'}.` + tail };
    return { answer: "I don't see a renewal option in this lease. If the document mentions one, add it under Renewal options — or mark the lease as having no renewal." + tail };
  }
  if (/(rent|how much|price|cost|monthly)/.test(q)) {
    // Written in markdown on purpose: the real model answers this way, so the demo has
    // to as well or it can't show that AnswerText renders it instead of printing the
    // asterisks and hyphens (George, 2026-07-30: "remove the noise").
    const lines = [`The annual base rent is **${usd(lease.base_rent)}**, per the lease.`, ''];
    if (lease.square_footage) {
      lines.push(
        `- Rate: **${usd(Math.round(lease.base_rent / lease.square_footage))}** per sq ft`,
        `- Premises: ${Number(lease.square_footage).toLocaleString()} SF`,
        `- Monthly: ${usd(Math.round(lease.base_rent / 12))}`,
        ''
      );
    }
    lines.push('The lease states:', '', '> Tenant shall pay Base Rent in equal monthly installments, in advance, on the first day of each calendar month.');
    return { answer: lines.join('\n') + tail };
  }
  if (/(escalat|increase|bump|raise|%)/.test(q)) {
    const esc = db.rent_escalations.find((e) => e.lease_id === lease.id);
    return { answer: esc
      ? `Rent escalates effective ${esc.effective_date}: ${esc.escalation_type === 'percent' ? `+${esc.escalation_value}%` : usd(esc.escalation_value)}${esc.new_base_rent ? ` (to ${usd(esc.new_base_rent)}/yr)` : ''}.`
      : "I don't see a scheduled rent escalation in this lease." + tail };
  }
  if (/(term|expire|end|start|commence|how long|length|date)/.test(q)) {
    return { answer: `The term runs from ${lease.lease_start || '—'} through ${lease.lease_termination_date || '—'}.` + tail };
  }
  if (/(roof|cam|tax|nnn|triple net|maintenance|expense|responsib)/.test(q)) {
    return { answer: `Per the lease terms: ${lease.lease_terms || 'see the lease document'}.${lease.roof_responsible ? ' This tenant is billed its pro-rata share of the roof.' : ' The landlord absorbs this tenant\'s roof share.'}` + tail };
  }
  const snippet = doc ? doc.split('\n').filter(Boolean).slice(1, 4).join(' ') : lease.lease_terms;
  return { answer: `Here's what the lease for ${lease.tenant_name} says: ${snippet}` + tail };
}

// Demo stand-in for the ask-portfolio Edge Function ("Ask Amlak"). Reads the
// structured snapshot the client already built and answers common questions from
// the seeded data, so the assistant works with no backend.
function demoAskPortfolio(body) {
  const q = String(body?.question || '').toLowerCase();
  const snap = body?.snapshot_obj || {};
  const tenants = (snap.properties || []).flatMap((p) => p.tenants || []);
  const foot =
    '\n\n(Demo mode gives a data-driven canned answer. Connected to your API key, the AI answers any question about your portfolio.)';
  const list = (arr, f) => (arr.length ? arr.map(f).join('\n') : '  (none)');

  // "Write to this tenant" — the demo twin of the live [EMAIL_DRAFT: name] marker.
  // Names the tenant the letter would go to (the one the question mentions, else the one
  // with the biggest balance, so the seeded portfolio always has an answer) and returns
  // draft_for so the ✉ button appears. Checked before the topic branches, because
  // "draft an email about their insurance" is a drafting request, not an insurance one.
  if (/\b(draft|write|compose|send|email|letter|notice)\b/.test(q) && tenants.length) {
    const named = tenants.find((t) => q.includes(String(t.tenant || '').toLowerCase().slice(0, 12)));
    const target = named || [...tenants].sort((a, b) => (b.balance_owed || 0) - (a.balance_owed || 0))[0];
    const bits = [
      target.balance_owed > 0 ? `owes $${Math.round(target.balance_owed).toLocaleString()}` : 'is current on rent',
      target.lease_end ? `lease runs to ${target.lease_end}` : null,
      target.base_rent ? `annual base rent $${Math.round(target.base_rent).toLocaleString()}` : null,
    ].filter(Boolean);
    return {
      answer: `${target.tenant} at ${target.property} — ${bits.join(', ')}. I can draft a letter on that basis for you to review and send.`,
      draft_for: target.tenant,
    };
  }

  // Respect the Settings switchboard: if a module is off, its facts aren't in the
  // snapshot, so don't answer about it (mirrors snapshotToText omitting the section).
  if (/insur/.test(q) && snap.insurance_shown === false) {
    return { answer: 'The Insurance module is turned off in Settings, so I’m not tracking policies right now. Turn it back on under Settings → Display & features to ask about insurance.' + foot };
  }
  if (/contract/.test(q) && snap.contracts_shown === false) {
    return { answer: 'Service contracts are turned off in Settings, so I’m not tracking them right now. Turn the module back on under Settings → Display & features to ask about contracts.' + foot };
  }

  if (/insur/.test(q) && /(no |without|missing|don'?t|lack|not have|which don)/.test(q)) {
    const none = tenants.filter((t) => !t.insurance_on_file);
    return { answer: `Tenants with NO insurance on file (${none.length}):\n` + list(none, (t) => `• ${t.tenant} — ${t.property}`) + foot };
  }
  if (/insur/.test(q)) {
    const ins = tenants.filter((t) => t.insurance_on_file);
    return { answer: `Tenants WITH insurance on file (${ins.length}):\n` + list(ins, (t) => `• ${t.tenant} — ${t.insurer || 'insurer on file'}, expires ${t.insurance_expiry || '—'}`) + foot };
  }
  if (/(owe|owes|owing|balance|money|outstanding|behind|unpaid)/.test(q)) {
    const owing = tenants.filter((t) => t.balance_owed > 0);
    return { answer: `Tenants who owe money (${owing.length}):\n` + list(owing, (t) => `• ${t.tenant} — $${Math.round(t.balance_owed).toLocaleString()}`) + foot };
  }
  if (/contract/.test(q)) {
    const props = (snap.properties || []).filter((p) => (p.service_contracts || []).length);
    return { answer: `Properties with service contracts (${props.length}):\n` + list(props, (p) => `• ${p.property}: ` + p.service_contracts.map((c) => `${c.service_type || 'contract'}${c.vendor ? ` (${c.vendor})` : ''}`).join(', ')) + foot };
  }
  // Roof — now answerable from the facts (the "Roof share billed" flag). No docs needed.
  if (/roof/.test(q)) {
    const yes = tenants.filter((t) => t.roof_billed);
    const no = tenants.filter((t) => !t.roof_billed);
    return { answer:
      `Roof expenses are billed to these tenants (${yes.length}):\n` + list(yes, (t) => `• ${t.tenant} — ${t.property}`) +
      `\n\nRoof is NOT billed to (landlord absorbs it) (${no.length}):\n` + list(no, (t) => `• ${t.tenant} — ${t.property}`) + foot };
  }
  // Anything else: the facts summary can't answer it → signal the "read my leases"
  // fallback so the 📄 button appears (demo mirrors the live needs_docs marker).
  return {
    answer: `That's not something the records summary tracks directly. You can have me read the full lease documents to answer it.`,
    needs_docs: true,
  };
}

// ---- E-signature ----------------------------------------------------------
// The demo's "token" is just the envelope id — there is no security boundary to protect in
// an in-memory sandbox, and pretending otherwise would only obscure what the LIVE function
// does. Live: 32 CSPRNG bytes, stored solely as sha256(token). See 0085 and the header of
// supabase/functions/sign-envelope/index.ts.
// Unique per row. The ids used to be derived from the envelope + event kind, which meant
// signing the same envelope twice in the sandbox produced two events with the SAME id —
// React dropped one from the record panel and warned about duplicate keys. Live these are
// gen_random_uuid(); the demo needs the same guarantee, not a readable string.
let evtSeq = 0;
const evtId = () => `evt-${(evtSeq += 1)}-${Math.random().toString(36).slice(2, 8)}`;

const demoSignUrl = (id) => `${globalThis.location?.origin || 'https://amlakre.com'}/sign/${id}`;

// ⚠ MIRROR of placementColumns() in supabase/functions/sign-envelope/index.ts and of
// hasPlacement() in src/lib/signPlacement.js — CLAUDE.md §3. All-or-nothing: an incomplete
// placement stores four nulls, so the executed PDF falls back to an appended signature page
// rather than stamping a signature at the bottom-left corner of page 1.
const NO_PLACE = { place_page: null, place_x: null, place_y: null, place_w: null };
function demoPlacement(p) {
  if (!p || typeof p !== 'object') return NO_PLACE;
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(p.page) || !ok(p.x) || !ok(p.y) || !ok(p.w)) return NO_PLACE;
  if (p.page < 1 || p.x < 0 || p.y < 0 || p.w <= 0) return NO_PLACE;
  return { place_page: Math.trunc(p.page), place_x: p.x, place_y: p.y, place_w: p.w };
}

// Demo stand-in for the ONE public edge function. Mirrors the real state machine — including
// the two refusals that matter — so the tenant-facing page can be driven end to end in the
// sandbox without a Supabase project.
function demoSignEnvelope(body) {
  const fail = (message, extra = {}) => ({ data: { error: message, ...extra }, error: { message } });
  const env = (db.signature_envelopes || []).find((e) => e.id === body?.token);
  // `not_found` mirrors the live function's 404 (as `closed` mirrors its 410) — supabase's
  // invoke() has no status to carry, so the shape has to say it. Without this the page fell
  // through to its generic "something went wrong" instead of the calm "this link isn't
  // valid", and the demo would have looked right while diverging from production.
  // The MESSAGE is identical either way — a bad token learns nothing from the difference.
  if (!env) return fail('This signing link isn’t valid.', { not_found: true });

  const expired = env.expires_at && new Date(env.expires_at).getTime() <= Date.now();
  const state = env.status !== 'sent' ? env.status : (expired ? 'expired' : 'sent');
  if (state !== 'sent') {
    const CLOSED = {
      signed: 'You’ve already signed this document. You’ll receive the completed copy by email once it’s countersigned.',
      executed: 'This document has already been completed and signed by both parties.',
      declined: 'This document was declined and can no longer be signed.',
      voided: 'This request was cancelled by the sender. Please contact them if you were expecting to sign something.',
      expired: 'This signing link has expired. Please contact the sender for a new one.',
    };
    return fail(CLOSED[state] || 'This document is no longer available to sign.', { closed: true, state });
  }

  const signer = (db.envelope_signers || []).find((s) => s.envelope_id === env.id && s.role === 'tenant');
  const prop = (db.properties || []).find((p) => p.id === env.property_id);
  const corp = (db.corporations || []).find((c) => c.id === prop?.corporation_id);
  const nowIso = new Date().toISOString();

  if (body?.action === 'view') {
    return ok({
      state: 'sent',
      title: env.title,
      filename: env.filename,
      message: env.message,
      business_name: corp?.name || 'Your landlord',
      property_name: prop?.name || null,
      signer_name: signer?.name || null,
      expires_at: env.expires_at,
      // A data: URL of the seeded one-page lease (store.js). There is no storage in DEMO
      // mode, so a signed-URL path is impossible — but pdf.js opens a data: URL happily,
      // which is what lets the sandbox demonstrate drag-to-sign on a document with a real
      // signature block instead of falling through to the "can't be shown" branch.
      document_url: `data:application/pdf;base64,${DEMO_PDF_B64}`,
      already_signed: !!signer?.signed_at,
    });
  }

  if (body?.action === 'decline') {
    Object.assign(env, { status: 'declined', declined_reason: body?.reason || null, updated_at: nowIso });
    (db.envelope_events ||= []).push({ id: evtId(), owner_id: DEMO_USER.id, envelope_id: env.id, kind: 'declined', actor: 'tenant', at: nowIso });
    return ok({ ok: true, state: 'declined' });
  }

  // sign — the same two refusals the live function makes before writing anything.
  if (body?.consent !== true) return fail('Please agree to sign electronically before signing.');
  const typed = String(body?.typed_name || '').trim();
  if (!typed) return fail('Please type your name.');
  if (!String(body?.signature_png || '').startsWith('data:image/png;base64,')) {
    return fail('Please draw or type your signature.');
  }

  if (signer) {
    Object.assign(signer, {
      consent_at: nowIso, signed_at: nowIso, typed_name: typed,
      signature_path: `signatures/${env.id}/tenant-demo.png`, ip: '203.0.113.10',
      user_agent: 'Demo browser',
      // Where they dropped it, in PDF points. Same all-or-nothing rule as the live function
      // (placementColumns in sign-envelope/index.ts) — a partial placement stores nulls and
      // falls back to an appended signature page rather than stamping at the page corner.
      ...demoPlacement(body?.placement),
    });
  }
  Object.assign(env, { status: 'signed', signed_at: nowIso, updated_at: nowIso });
  (db.envelope_events ||= []).push(
    { id: evtId(), owner_id: DEMO_USER.id, envelope_id: env.id, kind: 'consented', actor: 'tenant', at: nowIso },
    { id: evtId(), owner_id: DEMO_USER.id, envelope_id: env.id, kind: 'signed', actor: 'tenant', at: nowIso },
  );
  return ok({ ok: true, state: 'signed', signer_name: typed });
}

// Demo stand-in for the draft-tenant-email Edge Function. Returns PROSE ONLY — the
// salutation and paragraphs, no letterhead and no sign-off — exactly like the live
// function, so the client's letter() wrap is exercised for real in the demo.
// The demo's stand-in for the draft-announcement edge function. Mirrors the one rule that
// function exists to enforce: the prose it returns names no tenant, no suite and no
// figure, because a building-wide notice goes to everyone at once. Same {subject, body}
// shape, body = prose only (the client's letter() scaffold adds the letterhead).
function demoDraftAnnouncement(body) {
  const req = String(body?.request || '').toLowerCase();
  const where = body?.property?.name || 'the property';

  let subject = `Notice to Tenants — ${where}`;
  let paras;
  if (/park|lot|resurfac|pav|driveway/.test(req)) {
    subject = `Parking Lot Work — ${where}`;
    paras = [
      `We are writing to let all tenants know about upcoming work to the parking area at ${where}.`,
      `Access will be restricted while the work is carried out. Please use the alternate entrance during that period and let your staff and visitors know in advance.`,
      `We will keep disruption to a minimum and appreciate your patience. Please contact our office with any questions.`,
    ];
  } else if (/snow|ice|winter|storm/.test(req)) {
    subject = `Winter Weather Procedures — ${where}`;
    paras = [
      `As the winter season approaches, we are writing to remind all tenants of the snow and ice procedures at ${where}.`,
      `Common areas and the parking lot will be cleared by our contractor. Please keep your own entrance clear and report any hazardous conditions to the office promptly.`,
      `Please contact our office with any questions.`,
    ];
  } else if (/holiday|hours|close|closure/.test(req)) {
    subject = `Holiday Hours — ${where}`;
    paras = [
      `We are writing to inform all tenants of the upcoming holiday schedule at ${where}.`,
      `The management office will operate on reduced hours during the holiday period. Building access and emergency contacts are unchanged.`,
      `Please contact our office with any questions.`,
    ];
  } else {
    paras = [
      `We are writing to all tenants at ${where} regarding an item of building business.`,
      `${String(body?.request || 'Further details will follow.').trim()}`,
      `Please contact our office with any questions.`,
    ];
  }
  return { subject, body: [`Dear Tenants,`, ...paras].join('\n\n') };
}

function demoDraftTenantEmail(body) {
  const t = body?.tenant || {};
  const req = String(body?.request || '').toLowerCase();
  const who = t.contact_name || t.tenant || 'Tenant';
  const where = t.property || 'the premises';
  const owes = Number(t.balance_owed) || 0;
  const usd = (n) => `$${Math.round(n).toLocaleString()}`;

  let subject = `Regarding your lease at ${where}`;
  let paras;
  if (/insur|certificate|coi/.test(req)) {
    subject = `Certificate of Insurance — ${where}`;
    paras = [
      `We are writing regarding the certificate of insurance for your premises at ${where}.`,
      t.insurance_expiry
        ? `Our records show your current policy${t.insurer ? ` with ${t.insurer}` : ''} expires ${t.insurance_expiry}. Please have your agent issue a renewed certificate naming the landlord as an additional insured, and forward a copy to our office.`
        : `We do not have a current certificate on file. Please have your agent issue one naming the landlord as an additional insured and forward a copy to our office.`,
      `If you have already sent it, please disregard this notice. Feel free to contact our office with any questions.`,
    ];
  } else if (/renew|option|extend|term/.test(req)) {
    subject = `Upcoming Lease Term — ${where}`;
    paras = [
      `We are writing regarding your lease at ${where}${t.lease_end ? `, which runs through ${t.lease_end}` : ''}.`,
      t.has_renewal_option
        ? `Your lease includes a renewal option. Please let us know whether you intend to exercise it so we can prepare the paperwork in good time.`
        : `As the term approaches its end, we would welcome a conversation about your plans for the space.`,
      `Please contact our office at your convenience and we will be glad to discuss the details.`,
    ];
  } else {
    subject = owes > 0 ? `Outstanding Balance — ${where}` : `Your Account — ${where}`;
    paras = [
      `We are writing regarding your account for the premises at ${where}.`,
      owes > 0
        ? `Our records show an outstanding balance of ${usd(owes)}${t.overdue_since ? `, outstanding since ${t.overdue_since}` : ''}. We would appreciate payment at your earliest convenience, or a call to let us know when we can expect it.`
        : `Your account is current and no payment is outstanding at this time. We appreciate your prompt payments and your continued tenancy.`,
      `If you have any questions about your account or believe our records are mistaken, please contact our office and we will review it with you.`,
    ];
  }
  return {
    subject,
    body: `Dear ${who},\n\n${paras.join('\n\n')}\n\n(Demo mode gives a canned draft. Connected to your API key, the AI writes the letter from your request and this tenant's actual figures.)`,
  };
}

// Demo stand-in for the review-lease Edge Function (the ⚠ Review this lease button).
// Reads the seeded lease TEXT for the same signals the live checklist asks about, so the
// demo's flags actually follow from the document on file rather than being a fixed list —
// re-running on a different tenant gives a different answer, as it would live.
function demoReviewLease(body) {
  const lease = (db.leases || []).find((l) => l.id === body?.lease_id);
  const text = String(lease?.lease_text || '').toLowerCase();
  const flags = [];
  const say = (key, quote) => flags.push({ key, quote });

  if (!/guarant/.test(text)) say('no_personal_guarantee', 'No guaranty clause appears in the lease.');
  if (!/(security deposit|deposit of)/.test(text)) say('no_security_deposit', 'No security deposit is required by the lease.');
  if (!/(late (fee|charge)|interest on)/.test(text)) say('no_late_fee', 'The lease does not state a late fee or interest on overdue rent.');
  if (!/holdover|hold over/.test(text)) say('no_holdover_premium', 'Holdover is not addressed.');
  if (!/insur/.test(text)) say('no_insurance_requirements', 'The lease does not require the tenant to carry liability insurance.');
  if (/exclusive/.test(text)) say('exclusive_use', 'Tenant is granted an exclusive use right at the property.');
  // Only when the lease actually GRANTS an option and prices it at something other than
  // market — "contains no option to renew" must not read as a fixed-rent option.
  if (/option to (renew|extend)/.test(text) && !/no option to (renew|extend)/.test(text) && !/(fair market|fmv)/.test(text)) {
    say('below_market_renewal', 'The renewal option states a fixed rent rather than fair market value.');
  }

  return {
    flags: flags.map((f) => {
      const def = LEASE_FLAG_DEFS.find((d) => d.key === f.key);
      return { key: f.key, severity: def?.severity || 'info', title: def?.title || f.key, note: def?.note || '', quote: f.quote };
    }),
    model: 'demo',
  };
}

// Demo stand-in for the ask-leases Edge Function ("read my leases"). Keyword-routes
// to a canned grouped answer drawn from the seeded leases, so the docs fallback UX
// works with no backend. Connected to a real API key, it reads the full lease texts.
function demoAskLeases(body) {
  const q = String(body?.question || '').toLowerCase();
  const foot = '\n\n(Demo mode gives a canned answer from the seeded leases. Connected to your API key, the AI reads every lease document and answers grouped by tenant.)';
  const leases = (db.leases || []).filter((l) => l.is_active !== false);
  const propName = (id) => (db.properties.find((p) => p.id === id) || {}).name || 'property';
  const line = (l, verdict) => `• ${l.tenant_name} — ${propName(l.property_id)}: ${verdict}`;
  if (/(roof|structural|structure)/.test(q)) {
    return { answer: 'From the lease documents (roof responsibility):\n' +
      leases.map((l) => line(l, l.roof_responsible ? 'Tenant pays its pro-rata share of roof expenses.' : 'Landlord maintains the roof and structure.')).join('\n') + foot };
  }
  if (/(cam|tax|nnn|triple net|additional rent|expense)/.test(q)) {
    return { answer: 'From the lease documents (expense responsibility):\n' +
      leases.map((l) => line(l, l.lease_terms || 'See the lease document.')).join('\n') + foot };
  }
  return { answer: 'From the lease documents:\n' +
    leases.map((l) => line(l, l.lease_terms || (l.lease_text || '').split('\n').filter(Boolean)[1] || 'See the lease document.')).join('\n') + foot };
}

// Postgres RPCs. Mirrors the real SQL functions so demo + tests exercise the same
// behavior the live app gets through supabase.rpc().
async function rpc(fn, args = {}) {
  if (fn === 'create_lease_tx') {
    const { p_lease = {}, p_escalations = [], p_renewals = [], p_abatements = [] } = args;
    const now = new Date().toISOString();
    const leaseId = newId('lea');
    (db.leases ||= []).push({
      id: leaseId, owner_id: DEMO_USER.id, created_at: now, updated_at: now,
      source: 'ai_extracted', extraction_status: 'reviewed',
      roof_responsible: false, no_renewal_option: false, is_active: true,
      ...p_lease,
    });
    for (const e of (p_escalations || [])) (db.rent_escalations ||= []).push({
      id: newId('esc'), owner_id: DEMO_USER.id, created_at: now, updated_at: now,
      escalation_type: 'manual', status: 'scheduled', ...e, lease_id: leaseId,
    });
    for (const r of (p_renewals || [])) (db.renewal_options ||= []).push({
      id: newId('ren'), owner_id: DEMO_USER.id, created_at: now, updated_at: now,
      status: 'pending', ...r, lease_id: leaseId,
    });
    for (const a of (p_abatements || [])) (db.rent_abatements ||= []).push({
      id: newId('aba'), owner_id: DEMO_USER.id, created_at: now, updated_at: now,
      kind: 'free', ...a, lease_id: leaseId,
    });
    return ok(leaseId);
  }
  // Rebuilding reminder rows is a live-DB concern (there are no reminders in demo) —
  // no-op cleanly so setNotifyLeadTimes doesn't log a spurious "unknown function".
  if (fn === 'regenerate_owner_reminders') return ok(null);
  return { data: null, error: { message: `mock rpc: unknown function ${fn}` } };
}

export const mockSupabase = {
  from: (table) => new QB(table),
  rpc,
  auth,
  storage,
  functions,
};
