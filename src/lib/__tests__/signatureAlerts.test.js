// fetchAlertData → buildAlerts → the notification feed, end to end for e-signature. The
// registry work in CLAUDE.md §4 is only "done" if the alert survives the whole chain, and
// each link below has its own way of failing silently:
//
//   • fetchAlertData not selecting envelopes      → the alert never exists
//   • the alertKey anchor missing envelope_id     → two envelopes share ONE dismissal
//   • no NOTIFY_COLUMNS entry                     → it lands in the catch-all nobody reads
//   • the feature gate not honoured               → it shows for accounts with esign off
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fetchAlertData } from '../api';
import { buildAlerts, alertKey } from '../alerts';
import { columnForRow } from '../notifyTypes';
import { supabase } from '../supabaseClient';

const RESET = async () => {
  await supabase.from('signature_envelopes').update({
    status: 'signed', signed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    executed_at: null, applied_at: null,
  }).eq('id', 'env-1');
  await supabase.from('signature_envelopes').update({ status: 'executed', applied_at: null }).eq('id', 'env-2');
  // env-5 is the CONTRACT envelope (0093) — executed and never read in. It raises its own
  // signature_apply, so every "no apply alert" assertion below is scoped to the lease side
  // rather than to the whole feed.
  await supabase.from('signature_envelopes').update({ status: 'executed', applied_at: null }).eq('id', 'env-5');
};

beforeEach(RESET);
afterEach(RESET);

const focuses = (alerts) => alerts.map((a) => a.focus);
// Only the envelopes anchored to a LEASE. A contract envelope raises the same two focuses
// through the same code, and the two sets must be told apart or each masks the other.
const onLeases = (alerts) => alerts.filter((a) => String(a.focus).startsWith('signature_') && a.lease_id);
const onContracts = (alerts) => alerts.filter((a) => String(a.focus).startsWith('signature_') && a.contract_id);

describe('a signed document reaches the landlord', () => {
  it('survives fetchAlertData → buildAlerts with the signer’s name attached', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    expect(data.envelopes.length).toBeGreaterThan(0);

    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    const countersign = alerts.find((a) => a.focus === 'signature_countersign');
    expect(countersign).toBeTruthy();
    expect(countersign.title).toContain('Second Amendment to Lease');
    expect(countersign.detail).toContain('Sam Rivera');
    // It must carry the ids the click-through needs to land on the right lease.
    expect(countersign.lease_id).toBe('lease-1');
    expect(countersign.property_id).toBe('prop-1');
    expect(countersign.corporation_id).toBe('corp-1');
  });

  it('raises the executed-but-not-applied one too, and says nothing has changed', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    const apply = alerts.find((a) => a.focus === 'signature_apply');
    expect(apply).toBeTruthy();
    expect(apply.detail).toMatch(/nothing on .* has changed yet/);
  });

  it('goes quiet once the executed document has been applied', async () => {
    await supabase.from('signature_envelopes')
      .update({ applied_at: new Date().toISOString() }).eq('id', 'env-2');
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    expect(onLeases(alerts).map((a) => a.focus)).not.toContain('signature_apply');
    // …but the one still waiting on his signature stays.
    expect(focuses(alerts)).toContain('signature_countersign');
  });

  // An envelope still out with the tenant is NOT an alert — he can't do anything about it.
  it('says nothing about a document merely waiting on the tenant', async () => {
    await supabase.from('signature_envelopes')
      .update({ status: 'sent', signed_at: null }).eq('id', 'env-1');
    await supabase.from('signature_envelopes')
      .update({ status: 'sent', executed_at: null }).eq('id', 'env-2');
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    expect(onLeases(alerts)).toEqual([]);
  });
});

// ── The contracts side of the same chain (0093) ────────────────────────────────────────
// An envelope now has two kinds of home, and the alert has to know which. Getting this from
// the lease branch would send a landlord chasing a snow contract to a lease page that does
// not exist for it.
describe('a signed CONTRACT reaches the landlord', () => {
  it('raises the executed-but-not-read one, anchored to the contract and not to a lease', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const apply = onContracts(data && buildAlerts(data, undefined, new Date(), { features: null }))
      .find((a) => a.focus === 'signature_apply');
    expect(apply).toBeTruthy();
    expect(apply.contract_id).toBe('svc-2');
    expect(apply.lease_id).toBe(null);
    expect(apply.property_id).toBe('prop-2');
    // The words a landlord needs: this is not untidiness, the tenants are still being billed
    // off the old fee.
    expect(apply.title).toContain('Signed but not read');
    expect(apply.detail).toMatch(/fee, term and renewal are still the old ones/);
    expect(apply.action).toContain('Contracts tab');
  });

  it('says "vendor", never "tenant"', async () => {
    await supabase.from('signature_envelopes')
      .update({ status: 'signed', signed_at: new Date().toISOString(), executed_at: null }).eq('id', 'env-5');
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    const cs = onContracts(alerts).find((a) => a.focus === 'signature_countersign');
    expect(cs).toBeTruthy();
    // The signer's own name is on the row — a vendor, stitched from the same 'tenant' role.
    expect(cs.detail).toContain('GreenScape');
    expect(cs.detail).not.toContain('tenant');
  });

  it('goes quiet once its terms have been read in', async () => {
    await supabase.from('signature_envelopes')
      .update({ applied_at: new Date().toISOString() }).eq('id', 'env-5');
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    expect(onContracts(buildAlerts(data, undefined, new Date(), { features: null }))).toEqual([]);
  });

  // Two modules, two gates. Turning Service contracts off hides the tab the alert points at,
  // so the alert must go with it — while the LEASE signature alerts are untouched.
  it('is silenced by the Service-contracts module, leaving the lease ones alone', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const off = buildAlerts(data, undefined, new Date(), { features: ['leases', 'esign'] });
    expect(onContracts(off)).toEqual([]);
    expect(onLeases(off).length).toBeGreaterThan(0);
  });
});

describe('the registries the alert has to pass through', () => {
  it('two envelopes on the SAME lease get different dismissal keys', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = onLeases(buildAlerts(data, undefined, new Date(), { features: null }));
    expect(alerts).toHaveLength(2);
    // Both are about lease-1. Without envelope_id in the anchor chain both keys would
    // collapse to the same string and dismissing one would silently dismiss the other.
    expect(alerts[0].lease_id).toBe(alerts[1].lease_id);
    expect(alertKey(alerts[0])).not.toBe(alertKey(alerts[1]));
    alerts.forEach((a) => expect(alertKey(a)).not.toContain('undefined'));
  });

  it('lands in the Signatures column, not the catch-all', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    buildAlerts(data, undefined, new Date(), { features: null })
      .filter((a) => String(a.focus).startsWith('signature_'))
      .forEach((a) => expect(columnForRow(a)).toBe('signature'));
  });

  it('is silent when the module is off — both in the fetch and in the build', async () => {
    // The gate has to hold at BOTH layers: the query is skipped, and even if envelopes
    // arrive some other way buildAlerts refuses to raise them.
    const skipped = await fetchAlertData({ ledgerOn: false, esignOn: false });
    expect(skipped.envelopes).toEqual([]);

    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const off = buildAlerts(data, undefined, new Date(), { features: ['insurance', 'ledger'] });
    expect(focuses(off).filter((f) => String(f).startsWith('signature_'))).toEqual([]);
  });

  it('a never-chosen (null) feature set still shows them', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    expect(focuses(alerts)).toContain('signature_countersign');
  });
});
