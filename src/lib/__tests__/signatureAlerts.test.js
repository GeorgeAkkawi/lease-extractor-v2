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
};

beforeEach(RESET);
afterEach(RESET);

const focuses = (alerts) => alerts.map((a) => a.focus);

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
    expect(focuses(alerts)).not.toContain('signature_apply');
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
    expect(focuses(alerts)).not.toContain('signature_countersign');
    expect(focuses(alerts)).not.toContain('signature_apply');
  });
});

describe('the registries the alert has to pass through', () => {
  it('two envelopes on the SAME lease get different dismissal keys', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: true });
    const alerts = buildAlerts(data, undefined, new Date(), { features: null })
      .filter((a) => String(a.focus).startsWith('signature_'));
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
