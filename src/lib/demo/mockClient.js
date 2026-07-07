// In-memory mock of the subset of the Supabase client our app uses, so the UI is
// fully clickable in demo mode without any backend. Computes the v_property_totals
// and v_tenant_shares views the same way the SQL does (math stays in code).
import { seed, DEMO_USER } from './store';
import { effectiveRent } from '../escalations';
import { fmtDate } from '../format';

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
  const leases = db.leases.filter((l) => l.property_id === propertyId && l.is_active !== false);
  const totalSf = leases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  // Allocate over the WHOLE building's SF so the vacant share stays with the landlord.
  // Fall back to leased SF until a building size is entered (mirrors v_tenant_shares).
  const denom = Number(prop?.building_sf) || totalSf;
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
  not(field) { this.filters.push({ field, op: 'not_is_null' }); return this; }
  ilike(field, value) { this.filters.push({ field, op: 'ilike', value }); return this; }
  filter(field, op, value) { this.filters.push({ field, op, value }); return this; }
  order(field) { this._order = field; return this; }
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
      if (this._order) list = [...list].sort((a, b) => (a[this._order] > b[this._order] ? 1 : -1));
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
      const out = [];
      for (const pid of pids) {
        if (this.table === 'v_property_totals') { const r = propertyTotals(pid, yr); if (r) out.push(r); }
        else out.push(...tenantShares(pid, yr));
      }
      return this._wrap(out);
    }

    const list = db[this.table] || (db[this.table] = []);

    if (this._op === 'insert') {
      const items = Array.isArray(this._payload) ? this._payload : [this._payload];
      // Mirror the 0055 partial unique index: at most ONE live (non-void) invoice per
      // (lease_id, year). Raise the same 23505 the real DB does, so ensureInvoice /
      // upsertYearInvoice exercise their duplicate-fallback in demo + tests.
      if (this.table === 'invoices') {
        const dup = items.find((it) => (it.status ?? 'sent') !== 'void' &&
          list.some((r) => r.status !== 'void' && r.lease_id === it.lease_id && Number(r.year) === Number(it.year)));
        if (dup) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "invoices_one_live_per_lease_year"' } };
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
    if (this._order) rows = [...rows].sort((a, b) => (a[this._order] > b[this._order] ? 1 : -1));
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
};

const storage = {
  from() {
    return {
      async upload() { return ok({ path: 'demo/upload' }); },
      async download() { return ok(new Blob([])); },
      async createSignedUrl() { return ok({ signedUrl: '#demo-document' }); },
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
        },
        // One-time plain-text copy cached on the lease for the AI assistant.
        full_text: [
          'COMMERCIAL LEASE AGREEMENT',
          'Tenant: Summit Fitness LLC. Premises: Suite 210, approximately 4,200 rentable square feet.',
          'Base Rent: $96,000.00 per annum, payable in equal monthly installments of $8,000.00.',
          'Term: Five (5) years commencing March 1, 2025 and expiring February 28, 2030.',
          'Annual Adjustment: Base Rent shall increase by three percent (3%) on each anniversary, first effective March 1, 2026.',
          'Lease Type: Triple net (NNN). Tenant pays its pro-rata share of property taxes, CAM, and insurance.',
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
    if (name === 'extract-insurance') {
      return ok(demoExtractInsurance());
    }
    if (name === 'extract-contract') {
      return ok(demoExtractContract(body));
    }
    if (name === 'extract-addendum') {
      return ok(demoExtractAddendum());
    }
    if (name === 'draft-invoice') {
      const facts = demoInvoiceFacts(body);
      return ok({ facts, from: facts.business?.contact_email ?? null });
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
  const roof = share && share.roof_responsible ? share.roof_amt : 0; // separate roof line
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
    base_rent_annual: share ? share.base_rent : (lease?.base_rent || 0),
    cam_annual: share ? share.cam_amount : 0,
    tax_annual: share ? share.tax_amount : 0,
    roof_annual: roof,
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
      summary: `Extends the term through ${fmtDate(newEnd)} at $132,000/yr with a 3% bump in ${y + 2}.`,
    },
    full_text: [
      'FIRST AMENDMENT TO COMMERCIAL LEASE',
      `This amendment, dated January 1, ${y}, modifies the lease between the parties.`,
      `1. Term. The Lease term is extended through December 31, ${y + 5}.`,
      `2. Base Rent. Effective January 1, ${y}, annual base rent is $132,000.00, payable monthly.`,
      `3. Escalation. Base rent increases three percent (3%) on January 1, ${y + 2}.`,
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
    const psf = lease.square_footage ? ` (${usd(Math.round(lease.base_rent / lease.square_footage))} per sq ft on ${Number(lease.square_footage).toLocaleString()} SF)` : '';
    return { answer: `The annual base rent is ${usd(lease.base_rent)}${psf}, per the lease.` + tail };
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
  return { answer: `Your portfolio: ${snap.property_count || 0} properties, ${snap.tenant_count || 0} tenants. Ask about insurance, contracts, rent, expirations, or who owes money.` + foot };
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
  return { data: null, error: { message: `mock rpc: unknown function ${fn}` } };
}

export const mockSupabase = {
  from: (table) => new QB(table),
  rpc,
  auth,
  storage,
  functions,
};
