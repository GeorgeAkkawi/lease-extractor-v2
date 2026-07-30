// Rider dates — the period a rider GOVERNS, which is not the day it was signed.
//
// George, 2026-07-30: "input the dates of the rider". lease_addendums has carried only
// amendment_date (the signing date) since 0021, and the two are routinely months apart:
// the live Denny's rider is dated June 30 2023 and governs Jul 1 2023 → Apr 30 2033.
// 0070 adds effective_from / effective_to and backfills them from each rider's own
// cached extraction.

import { describe, it, expect } from 'vitest';
import { coversLabel, riderTitle, sortRiders, riderHasText } from '../riders';
import {
  createCorporation, createProperty, createLease,
  createAddendum, listAddendums,
} from '../api';

describe('coversLabel', () => {
  it('reads as a period when the rider states both ends', () => {
    expect(coversLabel({ effective_from: '2023-07-01', effective_to: '2033-04-30' }))
      .toBe('July 1, 2023 → April 30, 2033');
  });

  it('says only what it knows — one end, or the other', () => {
    expect(coversLabel({ effective_from: '2023-07-01' })).toBe('From July 1, 2023');
    expect(coversLabel({ effective_to: '2033-04-30' })).toBe('Through April 30, 2033');
  });

  it('falls back to the signing date rather than inventing a period', () => {
    // The assignment rider legitimately has neither: it swaps the tenant on a date and
    // governs nothing thereafter. Claiming a window for it would be a lie.
    expect(coversLabel({ amendment_date: '2021-06-22' })).toBe('Dated June 22, 2021');
    expect(coversLabel({})).toBe('—');
    expect(coversLabel(null)).toBe('—');
  });
});

describe('riderTitle', () => {
  it('uses the rider’s own label when it has one', () => {
    expect(riderTitle({ label: 'Third Addendum to Lease', kind: 'extension' })).toBe('Third Addendum to Lease');
  });

  it('names what it did when the document never titled itself', () => {
    // The extractor leaves label null on an untitled rider — a bare dash in a list of
    // "Open rider" buttons tells you nothing about which one to open.
    expect(riderTitle({ label: null, kind: 'extension' })).toBe('Extension');
    expect(riderTitle({ label: '   ', kind: 'assignment' })).toBe('Assignment');
    expect(riderTitle({})).toBe('Rider');
  });
});

describe('sortRiders', () => {
  it('walks the lease forward in time — oldest first, by the governing date', () => {
    const out = sortRiders([
      { id: 'c', effective_from: '2025-01-01' },
      { id: 'a', effective_from: '2021-01-01' },
      { id: 'b', effective_from: '2023-01-01' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the signing date, and sinks an undated rider to the bottom', () => {
    const out = sortRiders([
      { id: 'undated' },
      { id: 'signed', amendment_date: '2022-05-01' },
      { id: 'governed', effective_from: '2020-05-01' },
    ]);
    expect(out.map((r) => r.id)).toEqual(['governed', 'signed', 'undated']);
  });

  it('does not mutate the array it was given', () => {
    const input = [{ id: 'b', effective_from: '2025-01-01' }, { id: 'a', effective_from: '2020-01-01' }];
    sortRiders(input);
    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('riderHasText', () => {
  it('is true only when there is something to open', () => {
    expect(riderHasText({ addendum_text: 'FIRST AMENDMENT…' })).toBe(true);
    expect(riderHasText({ addendum_text: '   ' })).toBe(false);
    expect(riderHasText({ addendum_text: null })).toBe(false);
    expect(riderHasText(null)).toBe(false);
  });
});

describe('saving a rider', () => {
  async function freshLease() {
    const corp = await createCorporation('Rider Dates Holdings');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Dates Plaza', address: '1 Date St', building_sf: 10000 });
    return createLease({
      property_id: prop.id, tenant_name: 'Dates Tenant', square_footage: 2000,
      base_rent: 60000, lease_start: '2020-01-01', lease_termination_date: '2028-12-31',
    });
  }

  it('keeps the governing period alongside the signing date', async () => {
    const lease = await freshLease();
    await createAddendum({
      lease_id: lease.id, label: 'Third Addendum to Lease', kind: 'extension',
      amendment_date: '2023-06-30', effective_from: '2023-07-01', effective_to: '2033-04-30',
    });
    const [saved] = await listAddendums(lease.id);
    expect(saved.amendment_date).toBe('2023-06-30');
    expect(saved.effective_from).toBe('2023-07-01');
    expect(saved.effective_to).toBe('2033-04-30');
    expect(coversLabel(saved)).toBe('July 1, 2023 → April 30, 2033');
  });
});
