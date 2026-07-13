// Portfolio snapshot for the "Ask Amlak" assistant. Pure JS — no network, no AI.
// It shapes the account's structured records (tenants, insurance, service
// contracts, rent, dates, balances, roof responsibility, lease terms, escalations,
// abatements, annual reports) into a compact, facts-only summary the AI answers
// over. Deliberately carries NO document text — just the facts the app already
// computed — so it stays a few KB and the AI call stays sub-cent. When a question
// needs something not in these facts (e.g. an obscure clause), the app offers a
// separate "read my leases" fallback that reads the cached documents.
import { byTermEnd } from './leaseSearch';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const txt = (s) => String(s ?? '').trim();
const stamp = (r) => r?.updated_at || r?.created_at || '';

// null / undefined enabled set = everything on (mirrors isFeatureOn in features.js).
const featureOn = (enabled, key) => (enabled == null ? true : enabled.includes(key));

// Lowercase / trim / collapse whitespace so "Who owes money?" and "who  owes money"
// map to the same cache key.
export function normalizeQuestion(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A cheap content fingerprint of the portfolio: row counts + the latest change
// stamp of each record type. Adding, editing (the updated_at trigger bumps it),
// or removing any lease / policy / contract / escalation / abatement / annual
// report flips the fingerprint, so a cached answer built on the old data stops
// matching. Order-independent.
// Two record types get a value-based component instead of a stamp, because they
// change who-owes / what's-billed WITHOUT bumping any updated_at above:
//   • balances — recording/deleting a PAYMENT changes outstanding money;
//   • shares — editing a property's expenses re-splits every tenant's CAM/tax/roof.
export function snapshotFingerprint({
  leases = [],
  insurance = [],
  contracts = [],
  balances = [],
  escalations = [],
  abatements = [],
  annualReports = [],
  shares = [],
  features,
} = {}) {
  const maxStamp = (arr) => arr.reduce((m, r) => { const s = stamp(r); return s > m ? s : m; }, '');
  const open = (balances || []).filter(
    (b) => b && b.display_status !== 'void' && b.display_status !== 'draft' && Number(b.balance) > 0
  );
  const owedCents = Math.round(open.reduce((s, b) => s + Number(b.balance), 0) * 100);
  // Sum every share row's billed components so an expense edit (which re-splits
  // CAM/tax/roof but bumps no lease/updated_at) flips the fingerprint too.
  const sharesCents = Math.round(
    (shares || []).reduce(
      (s, r) => s + (Number(r.cam_amount) || 0) + (Number(r.tax_amount) || 0) + (Number(r.roof_amt) || 0),
      0
    ) * 100
  );
  // The enabled feature set is part of the fingerprint so a cached answer built while a
  // module was ON can't be served after it's turned OFF (and vice-versa).
  const feat = features == null ? 'all' : [...features].sort().join(',');
  return [
    'v4', // bumped from v3: the summary now carries far more facts — every v3-era
          // cached answer (built on the thinner summary) must stop matching.
    `L${leases.length}:${maxStamp(leases)}`,
    `I${insurance.length}:${maxStamp(insurance)}`,
    `C${contracts.length}:${maxStamp(contracts)}`,
    `E${escalations.length}:${maxStamp(escalations)}`,
    `A${abatements.length}:${maxStamp(abatements)}`,
    `R${annualReports.length}:${maxStamp(annualReports)}`,
    `B${open.length}:${owedCents}`,
    `S${shares.length}:${sharesCents}`,
    `F${feat}`,
  ].join('|');
}

// Build the structured snapshot. All inputs are plain rows straight from the DB
// (see fetchPortfolioSnapshot in api.js). `today` is an ISO date (YYYY-MM-DD)
// so expiry/overdue flags are deterministic and testable.
export function buildPortfolioSnapshot({
  corporations = [],
  properties = [],
  leases = [],
  insurance = [],
  contracts = [],
  renewals = [],
  balances = [],
  escalations = [],
  abatements = [],
  annualReports = [],
  shares = [],
  totals = [],
  features,
  today,
} = {}) {
  // Skip the insurance / contract facts entirely when the module is switched off in
  // Settings, so Ask Amlak never reads (or answers about) a section the landlord hid.
  const insuranceOn = featureOn(features, 'insurance');
  const contractsOn = featureOn(features, 'contracts');
  if (!insuranceOn) insurance = [];
  if (!contractsOn) contracts = [];
  // Local calendar date, not UTC — after ~8pm Eastern the UTC date is already
  // tomorrow, which would flip expiry/overdue flags a day early (same rule as
  // localDateIso in api.js / app_today() in SQL).
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const todayIso = today || `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
  const isPast = (d) => !!d && String(d) < todayIso;

  const corpById = Object.fromEntries(corporations.map((c) => [c.id, c]));

  // Active insurance only (archived policies are history). Index tenant policies by
  // lease, landlord policies by property.
  const tenantInsByLease = {};
  const landlordInsByProp = {};
  for (const p of insurance) {
    if (p.archived_at) continue;
    if (p.party === 'tenant' && p.lease_id) tenantInsByLease[p.lease_id] = p;
    else if (p.party === 'landlord' && p.property_id) landlordInsByProp[p.property_id] = p;
  }

  // Service contracts grouped by property.
  const contractsByProp = {};
  for (const c of contracts) (contractsByProp[c.property_id] ||= []).push(c);

  // A lease has an available renewal option when it carries a renewal row that
  // hasn't been exercised yet (status other than 'applied').
  const hasRenewal = new Set(
    (renewals || []).filter((r) => r.status !== 'applied').map((r) => r.lease_id)
  );

  // Amount still owed per tenant + the earliest due date behind it (for "overdue
  // since"): sum live (non-void, non-draft) invoice balances.
  const owedByLease = {};
  const overdueSinceByLease = {};
  for (const b of balances || []) {
    if (b.display_status === 'void' || b.display_status === 'draft') continue;
    const bal = Number(b.balance) || 0;
    if (bal > 0 && b.lease_id) {
      owedByLease[b.lease_id] = (owedByLease[b.lease_id] || 0) + bal;
      if (b.due_date && (!overdueSinceByLease[b.lease_id] || b.due_date < overdueSinceByLease[b.lease_id])) {
        overdueSinceByLease[b.lease_id] = b.due_date;
      }
    }
  }

  // This year's billed CAM / tax / roof share per tenant (from v_tenant_shares).
  const shareByLease = {};
  for (const s of shares || []) if (s.lease_id) shareByLease[s.lease_id] = s;

  // Property-level occupancy / vacancy / revenue (from v_property_totals).
  const totalsByProp = {};
  for (const t of totals || []) if (t.property_id) totalsByProp[t.property_id] = t;

  // Next SCHEDULED rent step per lease: the earliest step dated after today, and
  // still within the committed term (a step past the term end belongs to an
  // un-exercised renewal — same gate the schedule editor uses).
  const leaseEndById = {};
  for (const l of leases) leaseEndById[l.id] = l.lease_termination_date || null;
  const nextStepByLease = {};
  for (const e of escalations || []) {
    if (!e.lease_id || e.status !== 'scheduled') continue;
    const d = e.effective_date;
    if (!d || d <= todayIso) continue;
    const end = leaseEndById[e.lease_id];
    if (end && d > end) continue; // past the committed term → belongs to an un-exercised renewal
    const prev = nextStepByLease[e.lease_id];
    if (!prev || d < prev.effective_date) nextStepByLease[e.lease_id] = e;
  }

  // Active or upcoming free/reduced-rent window per lease (an ended one is history).
  const freeRentByLease = {};
  for (const a of abatements || []) {
    if (!a.lease_id) continue;
    if (a.end_date && a.end_date < todayIso) continue; // ended
    const active = (!a.start_date || a.start_date <= todayIso);
    const prev = freeRentByLease[a.lease_id];
    // Prefer an active window; otherwise the soonest upcoming one.
    if (!prev || (active && !prev.active) || (a.start_date && prev.start_date && a.start_date < prev.start_date)) {
      freeRentByLease[a.lease_id] = { ...a, active };
    }
  }

  // Annual state-report status per corporation.
  const reportByCorp = {};
  for (const r of annualReports || []) if (r.corporation_id) reportByCorp[r.corporation_id] = r;

  // Include ALL leases — a holdover (is_active === false) tenant still occupies
  // its space and still owes rent until the landlord removes it (George's rule),
  // so it must be answerable here; it's flagged so the AI can say "expired — held
  // over" rather than treating it as a current lease.
  const leasesByProp = {};
  for (const l of leases) (leasesByProp[l.property_id] ||= []).push(l);

  const propsOut = [...properties]
    .sort((a, b) => txt(a.name).localeCompare(txt(b.name)))
    .map((prop) => {
      const li = landlordInsByProp[prop.id];
      const pt = totalsByProp[prop.id] || null;
      const tenants = (leasesByProp[prop.id] || [])
        .slice()
        .sort(byTermEnd)
        .map((l) => {
          const ti = tenantInsByLease[l.id];
          const sh = shareByLease[l.id];
          const cam = sh ? num(sh.cam_amount) : null;
          const tax = sh ? num(sh.tax_amount) : null;
          const roof = sh ? num(sh.roof_amt) : null;
          const base = num(l.base_rent);
          const total = sh
            ? (base || 0) + (cam || 0) + (tax || 0) + (roof || 0)
            : null;
          const step = nextStepByLease[l.id] || null;
          const fr = freeRentByLease[l.id] || null;
          return {
            tenant: txt(l.tenant_name) || 'Tenant',
            tenant_id: l.id,
            corpId: prop.corporation_id || null,
            propId: prop.id,
            property: txt(prop.name),
            holdover: l.is_active === false,
            sqft: num(l.square_footage),
            base_rent: base,
            lease_start: l.lease_start || null,
            lease_end: l.lease_termination_date || null,
            has_renewal_option: hasRenewal.has(l.id),
            roof_billed: !!l.roof_responsible,
            lease_terms: txt(l.lease_terms) || null,
            contact_name: txt(l.tenant_contact_name) || null,
            email: txt(l.tenant_email) || null,
            suite: txt(l.premises_address) || null,
            billed_cam: cam,
            billed_tax: tax,
            billed_roof: roof,
            billed_total: total,
            next_step: step ? { date: step.effective_date, amount: num(step.new_base_rent) } : null,
            free_rent: fr
              ? { kind: txt(fr.kind) || 'free', start: fr.start_date || null, end: fr.end_date || null, active: fr.active }
              : null,
            insurance_on_file: !!ti,
            insurer: ti ? txt(ti.insurer) || null : null,
            insurance_expiry: ti ? ti.expiry_date || null : null,
            insurance_expired: ti ? isPast(ti.expiry_date) : false,
            // additional_insured: true (named) / false (explicitly not) / null (unknown).
            additional_insured: ti ? (ti.additional_insured === true ? 'yes' : ti.additional_insured === false ? 'no' : null) : null,
            balance_owed: owedByLease[l.id] || 0,
            overdue_since: overdueSinceByLease[l.id] || null,
          };
        });
      return {
        propId: prop.id,
        corpId: prop.corporation_id || null,
        corporation: txt(corpById[prop.corporation_id]?.name) || null,
        property: txt(prop.name),
        address: txt(prop.address) || null,
        building_sf: num(prop.building_sf),
        occupancy: pt ? num(pt.occupancy) : null,
        vacant_sf: pt ? num(pt.vacant_sf) : null,
        annual_revenue: pt ? num(pt.total_revenue) : null,
        landlord_insurance: {
          on_file: !!li,
          insurer: li ? txt(li.insurer) || null : null,
          expiry: li ? li.expiry_date || null : null,
          expired: li ? isPast(li.expiry_date) : false,
        },
        service_contracts: (contractsByProp[prop.id] || []).map((c) => ({
          vendor: txt(c.vendor) || null,
          service_type: txt(c.service_type) || null,
          amount: num(c.amount),
          frequency: txt(c.frequency) || null,
          end_date: c.end_date || null,
          expired: isPast(c.end_date),
        })),
        tenants,
      };
    });

  // Corporations with their annual-report filing status (core — never feature-gated).
  const corpsOut = [...corporations]
    .sort((a, b) => txt(a.name).localeCompare(txt(b.name)))
    .map((c) => {
      const r = reportByCorp[c.id];
      return {
        id: c.id,
        name: txt(c.name) || 'Corporation',
        annual_report_due: r ? r.due_date || null : null,
        annual_report_last_filed: r ? r.last_filed_date || null : null,
        annual_report_overdue: r ? isPast(r.due_date) : false,
        has_annual_report: !!r,
      };
    });

  const tenantCount = propsOut.reduce((n, p) => n + p.tenants.length, 0);
  return {
    today: todayIso,
    fingerprint: snapshotFingerprint({ leases, insurance, contracts, balances, escalations, abatements, annualReports, shares, features }),
    property_count: propsOut.length,
    tenant_count: tenantCount,
    // Let snapshotToText omit a whole section (rather than say "NONE on file") when the
    // module is off — off ≠ empty.
    insurance_shown: insuranceOn,
    contracts_shown: contractsOn,
    corporations: corpsOut,
    properties: propsOut,
  };
}

// Render the snapshot as compact labeled text — what the AI actually reads. One
// block per property; one line per tenant. Money/SF shown plainly (already
// computed, never asks the model to do arithmetic).
export function snapshotToText(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.properties)) return '(no portfolio data)';
  const money = (n) => (n == null ? '—' : `$${Math.round(Number(n)).toLocaleString('en-US')}`);
  const sf = (n) => (n == null ? '—' : `${Number(n).toLocaleString('en-US')} SF`);
  const pct = (n) => (n == null ? '—' : `${Math.round(Number(n) * 100)}%`);
  const date = (d) => d || '—';

  // Off ≠ empty: when a module is hidden in Settings, leave its facts out of the summary
  // entirely so the assistant doesn't answer about a section the landlord turned off.
  const showInsurance = snapshot.insurance_shown !== false;
  const showContracts = snapshot.contracts_shown !== false;

  const lines = [`PORTFOLIO SUMMARY (as of ${snapshot.today})`, `${snapshot.property_count} properties · ${snapshot.tenant_count} tenants`, ''];

  // Corporations + their annual-report filing dates.
  if ((snapshot.corporations || []).length) {
    lines.push('CORPORATIONS (annual state report filing):');
    for (const c of snapshot.corporations) {
      lines.push(
        `  - ${c.name}: ${c.has_annual_report
          ? `annual report due ${date(c.annual_report_due)}${c.annual_report_overdue ? ' — OVERDUE' : ''}${c.annual_report_last_filed ? `, last filed ${date(c.annual_report_last_filed)}` : ''}`
          : 'no annual report on file'}`
      );
    }
    lines.push('');
  }

  for (const p of snapshot.properties) {
    lines.push(`PROPERTY: ${p.property}${p.address ? ` — ${p.address}` : ''}${p.building_sf ? ` (${sf(p.building_sf)})` : ''}${p.corporation ? ` · owner: ${p.corporation}` : ''}`);
    if (p.occupancy != null || p.vacant_sf != null || p.annual_revenue != null) {
      const bits = [];
      if (p.occupancy != null) bits.push(`occupancy ${pct(p.occupancy)}`);
      if (p.vacant_sf != null) bits.push(`vacant ${sf(p.vacant_sf)}`);
      if (p.annual_revenue != null) bits.push(`annual rent roll ${money(p.annual_revenue)}`);
      lines.push(`  ${bits.join(' · ')}`);
    }
    if (showInsurance) {
      const li = p.landlord_insurance;
      lines.push(
        `  Landlord insurance: ${li.on_file ? `on file${li.insurer ? ` (${li.insurer})` : ''}, expires ${date(li.expiry)}${li.expired ? ' — EXPIRED' : ''}` : 'NONE on file'}`
      );
    }
    if (showContracts) {
      if (p.service_contracts.length) {
        const cs = p.service_contracts
          .map((c) => `${c.service_type || 'contract'}${c.vendor ? ` — ${c.vendor}` : ''} (ends ${date(c.end_date)}${c.expired ? ', EXPIRED' : ''}${c.amount != null ? `, ${money(c.amount)}${c.frequency ? `/${c.frequency}` : ''}` : ''})`)
          .join('; ');
        lines.push(`  Service contracts: ${cs}`);
      } else {
        lines.push('  Service contracts: none on file');
      }
    }
    if (p.tenants.length) {
      lines.push('  Tenants (soonest lease end first):');
      for (const t of p.tenants) {
        // Line 1: identity + lease term + rent.
        lines.push(
          `   - ${t.tenant}${t.holdover ? ' [EXPIRED — HELD OVER]' : ''} — ${sf(t.sqft)}, base rent ${money(t.base_rent)}/yr, lease ${date(t.lease_start)} to ${date(t.lease_end)}, renewal option: ${t.has_renewal_option ? 'yes' : 'no'}.`
        );
        // Line 2: who-pays-what facts (roof, lease type, this year's CAM/tax bill, next step, free rent).
        const parts2 = [`Roof expenses billed to tenant: ${t.roof_billed ? 'YES' : 'no'}.`];
        if (t.lease_terms) parts2.push(`Lease type/notes: ${t.lease_terms}.`);
        if (t.billed_total != null) {
          const comps = [];
          if (t.billed_cam != null) comps.push(`CAM ${money(t.billed_cam)}`);
          if (t.billed_tax != null) comps.push(`tax ${money(t.billed_tax)}`);
          if (t.billed_roof) comps.push(`roof ${money(t.billed_roof)}`);
          parts2.push(`This year's additional-rent share: ${comps.join(' + ') || '—'}; total annual bill ${money(t.billed_total)}.`);
        }
        if (t.next_step) parts2.push(`Next rent step: ${date(t.next_step.date)}${t.next_step.amount != null ? ` → ${money(t.next_step.amount)}/yr` : ''}.`);
        if (t.free_rent) parts2.push(`${t.free_rent.kind === 'free' ? 'Free' : 'Reduced'} rent ${t.free_rent.active ? '(active)' : '(upcoming)'} ${date(t.free_rent.start)} to ${date(t.free_rent.end)}.`);
        lines.push(`     ${parts2.join(' ')}`);
        // Line 3: insurance + contact + balance.
        const parts3 = [];
        if (showInsurance) {
          parts3.push(
            `Insurance: ${t.insurance_on_file ? `on file${t.insurer ? ` (${t.insurer})` : ''}, expires ${date(t.insurance_expiry)}${t.insurance_expired ? ' — EXPIRED' : ''}` : 'NONE on file'}${t.additional_insured ? `, landlord named as additional insured: ${t.additional_insured}` : ''}.`
          );
        }
        const contact = [t.contact_name, t.email, t.suite && `suite ${t.suite}`].filter(Boolean).join(', ');
        if (contact) parts3.push(`Contact: ${contact}.`);
        parts3.push(`Owes: ${money(t.balance_owed)}${t.balance_owed > 0 && t.overdue_since ? ` (overdue since ${date(t.overdue_since)})` : ''}.`);
        lines.push(`     ${parts3.join(' ')}`);
      }
    } else {
      lines.push('  Tenants: none');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
