// The per-property "is roof its own category?" checkbox (0097).
//
// George, 2026-08-06: *"some people might just throw it in a cam expense if repairs ever happen
// to it but others might want it separate."*
//
// TWO PROPERTIES OF THIS FLAG ARE LOAD-BEARING, and each has its own way of failing silently:
//
//   • it must read as ON when absent      → else every property built before 0097 goes quiet
//   • it must move NO money whatsoever    → else a display checkbox starts changing bills
//
// The second is what the bulk of this file guards. `roof_separate` is deliberately invisible to
// v_tenant_shares, billedComponents, componentizeSchedule and draft-invoice; nothing enforces
// that but these assertions, and the failure mode — a landlord unticking a box and re-pricing a
// tenant — is exactly the kind that gets noticed a year later at reconciliation.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { roofOffered, showRoof } from '../roofDisplay';
import { getTenantShares, getPropertyTotals, getProperty, setRoofSeparate } from '../api';
import { billedComponents } from '../reconciliation';
import { supabase } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();

// prop-1 (Maple Plaza) genuinely bills roof: roof line items and lease-1 roof-responsible.
const RESET = () => supabase.from('properties').update({ roof_separate: true }).eq('id', 'prop-1');
beforeEach(RESET);
afterEach(RESET);

describe('roofOffered — an absent column reads as ON', () => {
  // The whole reason the source says `!== false` rather than `=== true`. Every one of these
  // shapes exists somewhere: a row read before the migration, a demo fixture, an optimistic
  // object built client-side, a failed fetch.
  it.each([
    ['undefined property', undefined],
    ['null property', null],
    ['a property with no such column', { id: 'p1', name: 'Old Row' }],
    ['an explicit null', { roof_separate: null }],
    ['an explicit true', { roof_separate: true }],
  ])('%s → on', (_label, property) => {
    expect(roofOffered(property)).toBe(true);
  });

  it('only an explicit false turns it off', () => {
    expect(roofOffered({ roof_separate: false })).toBe(false);
  });
});

describe('showRoof — off hides only what is empty', () => {
  const off = { roof_separate: false };

  it('hides when the building says no and nothing is riding on it', () => {
    expect(showRoof(off, false)).toBe(false);
  });

  it('shows anyway wherever roof carries a figure', () => {
    // The half that makes the checkbox safe to hand a landlord: a roof total, a
    // roof-responsible lease, a tenant with a roof share — any one of them wins over the box.
    expect(showRoof(off, true)).toBe(true);
  });

  it('shows when the building says yes, figures or not', () => {
    expect(showRoof({ roof_separate: true }, false)).toBe(true);
    expect(showRoof(undefined, false)).toBe(true);
  });
});

// ── The line this feature must never cross ─────────────────────────────────────────────────
describe('the flag moves NO money', () => {
  it('leaves every tenant share identical when roof is switched off', async () => {
    const before = await getTenantShares('prop-1', Y);
    await setRoofSeparate('prop-1', false);
    const after = await getTenantShares('prop-1', Y);

    expect(after).toHaveLength(before.length);
    after.forEach((a, i) => {
      const b = before[i];
      expect(a.lease_id).toBe(b.lease_id);
      // The three figures a checkbox could plausibly have been wired into.
      expect(a.roof_amt).toBe(b.roof_amt);
      expect(a.roof_responsible).toBe(b.roof_responsible);
      expect(a.cam_amount).toBe(b.cam_amount);
    });
  });

  it('leaves billedComponents identical — the roof charge does not fold into CAM', async () => {
    const shares = await getTenantShares('prop-1', Y);
    const roofPayer = shares.find((s) => s.roof_responsible);
    expect(roofPayer).toBeTruthy();
    const before = billedComponents(roofPayer);
    expect(before.roof).toBeGreaterThan(0);

    await setRoofSeparate('prop-1', false);
    const after = billedComponents((await getTenantShares('prop-1', Y)).find((s) => s.lease_id === roofPayer.lease_id));

    // Not merely "the total is the same" — roof stays its OWN component. Folding it into CAM
    // would keep `total` intact while re-pricing anyone with a share_override_pct, because
    // roof splits by floor area and CAM honours the override (0073:74-76).
    expect(after.roof).toBe(before.roof);
    expect(after.cam).toBe(before.cam);
    expect(after.tax).toBe(before.tax);
    expect(after.total).toBe(before.total);
  });

  it('leaves the property totals identical', async () => {
    const before = await getPropertyTotals('prop-1', Y);
    await setRoofSeparate('prop-1', false);
    const after = await getPropertyTotals('prop-1', Y);
    expect(after.roof_total).toBe(before.roof_total);
    expect(after.roof_recovered).toBe(before.roof_recovered);
    expect(after.roof_unrecovered).toBe(before.roof_unrecovered);
    expect(after.noi).toBe(before.noi);
  });
});

describe('the evidence the screens actually read', () => {
  // ⚠ THE TRAP THIS ROUND ACTUALLY HIT. v_property_totals LOOKS like it answers "is any lease
  // here roof-responsible?" — 0049:29 computes resp_sf — but that lives in a CTE and is never
  // selected out, so the column does not exist (verified live: PostgREST 42703). A gate written
  // against totals.resp_sf is `undefined > 0`: permanently false, silently. Hence the property
  // page reads roof_responsible off v_tenant_shares instead, which really does carry it.
  it('v_property_totals does NOT expose resp_sf — the mock must not invent it either', async () => {
    const totals = await getPropertyTotals('prop-1', Y);
    expect(totals.resp_sf).toBeUndefined();
    expect(Number(totals.roof_total)).toBeGreaterThan(0); // the view is otherwise intact
  });

  it('a roof-responsible lease keeps roof on screen with the box unticked', async () => {
    const shares = await getTenantShares('prop-1', Y);
    expect(shares.some((s) => s.roof_responsible)).toBe(true);

    await setRoofSeparate('prop-1', false);
    const prop = await getProperty('prop-1');
    expect(roofOffered(prop)).toBe(false);
    // Unticked, and roof still shows — the building is still billing it.
    const totals = await getPropertyTotals('prop-1', Y);
    const roofInUse = Number(totals.roof_total) > 0 || shares.some((s) => s.roof_responsible);
    expect(showRoof(prop, roofInUse)).toBe(true);
  });

  it('the responsible-lease half stands on its own, with no roof figure entered', async () => {
    // The dead end the second half exists to prevent: nothing spent on roof yet, but a tenant
    // already on the hook for it. The box must stay so the cost has somewhere to go.
    const shares = await getTenantShares('prop-1', Y);
    await supabase.from('expense_records').update({ roof_total: 0 }).eq('id', 'exp-1');
    const totals = await getPropertyTotals('prop-1', Y);
    expect(Number(totals.roof_total)).toBe(0);
    expect(showRoof({ roof_separate: false }, Number(totals.roof_total) > 0 || shares.some((s) => s.roof_responsible))).toBe(true);
    await supabase.from('expense_records').update({ roof_total: 4000 }).eq('id', 'exp-1');
  });

  it('a property with no roof at all does go quiet', async () => {
    // NOTE: both seeded properties carry a roof total, and prop-1 also has a roof-responsible
    // lease — so neither goes quiet as seeded, which is the rule working, not a gap. Oak Center
    // is the one that CAN: no lease there is roof-responsible, so clearing the year's roof
    // figure is the whole of "this building doesn't do roof".
    const seeded = await getPropertyTotals('prop-2', Y);
    const shares = await getTenantShares('prop-2', Y);
    expect(shares.some((s) => s.roof_responsible)).toBe(false);
    expect(Number(seeded.roof_total)).toBeGreaterThan(0);
    expect(showRoof({ roof_separate: false }, true)).toBe(true); // still shown, as it must be

    await supabase.from('expense_records').update({ roof_total: 0 }).eq('id', 'exp-3');
    const cleared = await getPropertyTotals('prop-2', Y);
    const roofInUse = Number(cleared.roof_total) > 0 || shares.some((s) => s.roof_responsible);
    expect(roofInUse).toBe(false);
    expect(showRoof({ roof_separate: false }, roofInUse)).toBe(false);
    // …and ticking the box brings it straight back, empty or not.
    expect(showRoof({ roof_separate: true }, roofInUse)).toBe(true);

    await supabase.from('expense_records').update({ roof_total: seeded.roof_total }).eq('id', 'exp-3');
  });
});
