// Portfolio snapshot for the "Ask AI" assistant. Pure JS — no network, no AI.
// It shapes the account's structured records (tenants, insurance, service
// contracts, rent, dates, balances) into a compact, facts-only summary the AI
// answers over. Deliberately carries NO document text — just the facts the app
// already computed — so it stays a few KB and the AI call stays sub-cent.
import { byTermEnd } from './leaseSearch';

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const txt = (s) => String(s ?? '').trim();
const stamp = (r) => r?.updated_at || r?.created_at || '';

// Lowercase / trim / collapse whitespace so "Who owes money?" and "who  owes money"
// map to the same cache key.
export function normalizeQuestion(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A cheap content fingerprint of the portfolio: row counts + the latest change
// stamp of each record type. Adding, editing (the updated_at trigger bumps it),
// or removing any lease / policy / contract flips the fingerprint, so a cached
// answer built on the old data stops matching. Order-independent.
// Balances get their own component: recording or deleting a PAYMENT changes who
// owes money but bumps no updated_at above — without this, "who owes money?"
// kept serving the stale cached answer after a payment was recorded.
export function snapshotFingerprint({ leases = [], insurance = [], contracts = [], balances = [] } = {}) {
  const maxStamp = (arr) => arr.reduce((m, r) => { const s = stamp(r); return s > m ? s : m; }, '');
  const open = (balances || []).filter(
    (b) => b && b.display_status !== 'void' && b.display_status !== 'draft' && Number(b.balance) > 0
  );
  const owedCents = Math.round(open.reduce((s, b) => s + Number(b.balance), 0) * 100);
  return [
    'v2',
    `L${leases.length}:${maxStamp(leases)}`,
    `I${insurance.length}:${maxStamp(insurance)}`,
    `C${contracts.length}:${maxStamp(contracts)}`,
    `B${open.length}:${owedCents}`,
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
  today,
} = {}) {
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

  // Amount still owed per tenant: sum live (non-void, non-draft) invoice balances.
  const owedByLease = {};
  for (const b of balances || []) {
    if (b.display_status === 'void' || b.display_status === 'draft') continue;
    const bal = Number(b.balance) || 0;
    if (bal > 0 && b.lease_id) owedByLease[b.lease_id] = (owedByLease[b.lease_id] || 0) + bal;
  }

  const activeLeases = leases.filter((l) => l.is_active !== false);
  const leasesByProp = {};
  for (const l of activeLeases) (leasesByProp[l.property_id] ||= []).push(l);

  const propsOut = [...properties]
    .sort((a, b) => txt(a.name).localeCompare(txt(b.name)))
    .map((prop) => {
      const li = landlordInsByProp[prop.id];
      const tenants = (leasesByProp[prop.id] || [])
        .slice()
        .sort(byTermEnd)
        .map((l) => {
          const ti = tenantInsByLease[l.id];
          return {
            tenant: txt(l.tenant_name) || 'Tenant',
            tenant_id: l.id,
            corpId: prop.corporation_id || null,
            propId: prop.id,
            property: txt(prop.name),
            sqft: num(l.square_footage),
            base_rent: num(l.base_rent),
            lease_start: l.lease_start || null,
            lease_end: l.lease_termination_date || null,
            has_renewal_option: hasRenewal.has(l.id),
            insurance_on_file: !!ti,
            insurer: ti ? txt(ti.insurer) || null : null,
            insurance_expiry: ti ? ti.expiry_date || null : null,
            insurance_expired: ti ? isPast(ti.expiry_date) : false,
            balance_owed: owedByLease[l.id] || 0,
          };
        });
      return {
        propId: prop.id,
        corpId: prop.corporation_id || null,
        corporation: txt(corpById[prop.corporation_id]?.name) || null,
        property: txt(prop.name),
        address: txt(prop.address) || null,
        building_sf: num(prop.building_sf),
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

  const tenantCount = propsOut.reduce((n, p) => n + p.tenants.length, 0);
  return {
    today: todayIso,
    fingerprint: snapshotFingerprint({ leases: activeLeases, insurance, contracts, balances }),
    property_count: propsOut.length,
    tenant_count: tenantCount,
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
  const date = (d) => d || '—';

  const lines = [`PORTFOLIO SUMMARY (as of ${snapshot.today})`, `${snapshot.property_count} properties · ${snapshot.tenant_count} tenants`, ''];

  for (const p of snapshot.properties) {
    lines.push(`PROPERTY: ${p.property}${p.address ? ` — ${p.address}` : ''}${p.building_sf ? ` (${sf(p.building_sf)})` : ''}${p.corporation ? ` · owner: ${p.corporation}` : ''}`);
    const li = p.landlord_insurance;
    lines.push(
      `  Landlord insurance: ${li.on_file ? `on file${li.insurer ? ` (${li.insurer})` : ''}, expires ${date(li.expiry)}${li.expired ? ' — EXPIRED' : ''}` : 'NONE on file'}`
    );
    if (p.service_contracts.length) {
      const cs = p.service_contracts
        .map((c) => `${c.service_type || 'contract'}${c.vendor ? ` — ${c.vendor}` : ''} (ends ${date(c.end_date)}${c.expired ? ', EXPIRED' : ''}${c.amount != null ? `, ${money(c.amount)}${c.frequency ? `/${c.frequency}` : ''}` : ''})`)
        .join('; ');
      lines.push(`  Service contracts: ${cs}`);
    } else {
      lines.push('  Service contracts: none on file');
    }
    if (p.tenants.length) {
      lines.push('  Tenants (soonest lease end first):');
      for (const t of p.tenants) {
        lines.push(
          `   - ${t.tenant} — ${sf(t.sqft)}, base rent ${money(t.base_rent)}/yr, lease ${date(t.lease_start)} to ${date(t.lease_end)}, renewal option: ${t.has_renewal_option ? 'yes' : 'no'}. ` +
          `Insurance: ${t.insurance_on_file ? `on file${t.insurer ? ` (${t.insurer})` : ''}, expires ${date(t.insurance_expiry)}${t.insurance_expired ? ' — EXPIRED' : ''}` : 'NONE on file'}. ` +
          `Owes: ${money(t.balance_owed)}.`
        );
      }
    } else {
      lines.push('  Tenants: none');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}
