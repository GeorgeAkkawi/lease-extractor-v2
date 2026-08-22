import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { syncContractCamItems, syncRentPctCamItems, resyncPropertyBilling } from './api';
import { settleBillingChange } from './invalidate';

/**
 * Carry this fiscal year's service contracts and rent-percentage fees into CAM.
 *
 * ⚠ WHY THIS IS AN EFFECT AND NOT A `queryFn`. These two writes used to ride inside the
 * `['camLineItems', propId, year]` queryFn in `CamSection`, which is how "opening any fiscal
 * year keeps its contract costs and management fee current" was implemented. It did not work
 * on the Financials page: `useRecoverability` registers a SECOND observer on that same key
 * with a plain `listCamLineItems` queryFn, it belongs to the page fiber (so its options are
 * re-stamped onto the query after every commit), and React Query is last-writer-wins across
 * observers — so the plain read won and neither sync ever ran. The visible cost was a
 * management fee whose stored dollars stopped matching its own "5% of $X base rent" label,
 * and a multi-year contract that never got its CAM line when a new year was opened.
 *
 * The fix is not a cleverer queryFn, it is not being a queryFn at all: a read that writes can
 * always be pre-empted by a co-observer of its key. Runs once per property-year.
 */
export default function useCamSync(propId, year) {
  const qc = useQueryClient();
  const done = useRef('');

  useEffect(() => {
    if (!propId || !year) return;
    const tag = `${propId}:${year}`;
    if (done.current === tag) return;
    done.current = tag;
    let alive = true;
    (async () => {
      try {
        const contracts = await syncContractCamItems(propId, year);
        const rentPct = await syncRentPctCamItems(propId, year);
        // Both syncs are idempotent, so a plain revisit reports no change and nothing below
        // fires — opening a page must not rewrite bills for nothing.
        if (!contracts?.changed && !rentPct) return;
        await resyncPropertyBilling(propId, year);
        if (!alive) return;
        qc.invalidateQueries({ queryKey: ['camLineItems', propId, year] });
        qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
        settleBillingChange(qc, { propertyId: propId, year });
      } catch {
        // A sync that can't run leaves the year exactly as it was; the figures on screen are
        // the stored ones either way, and every other write on this page carries its own
        // error surface. Let the next visit try again rather than blocking the page.
        done.current = '';
      }
    })();
    return () => { alive = false; };
  }, [propId, year, qc]);
}
