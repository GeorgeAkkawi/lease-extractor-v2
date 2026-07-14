import { useQueryClient } from '@tanstack/react-query';
import {
  listCorporations, getCorporation, listProperties, getProperty,
  listLeases, getLease, listRenewals, listSnapshots, listExpiredLeases,
  getPropertyTotals, getExpenseRecord, fetchSearchIndex,
  listCorpCounts, listCorpRollups,
  listLeasesByProperties, listEscalationsByLeases, listPropertyTotalsByYear,
} from './api';

// ---------------------------------------------------------------------------
// Batched "load-all-children-then-seed-each-child's-cache" query options.
// A list page runs one of these as a single request, then seeds each card/row's
// own per-id cache (['leases', id] etc.) so the cards render fully populated in
// ONE pass — no per-card waterfall. The SAME options object is used by the page
// (useQuery) and by the hover prefetchers below, so a hovered page and the
// clicked page share one cache entry and one request.
// ---------------------------------------------------------------------------

// Leases workspace: all leases for a corp's properties → seed ['leases', propId].
export const leasesByPropertiesQuery = (qc, corpId, properties) => ({
  queryKey: ['leasesByProperties', corpId],
  queryFn: async () => {
    const byProp = await listLeasesByProperties(properties.map((p) => p.id));
    properties.forEach((p) => qc.setQueryData(['leases', p.id], byProp[p.id] || []));
    return byProp;
  },
});

// A property's lease list: all escalations for its leases → seed ['escalations', leaseId].
export const escalationsByLeasesQuery = (qc, propId, leases) => ({
  queryKey: ['escalationsByProperty', propId],
  queryFn: async () => {
    const byLease = await listEscalationsByLeases(leases.map((l) => l.id));
    leases.forEach((l) => qc.setQueryData(['escalations', l.id], byLease[l.id] || []));
    return byLease;
  },
});

// Financials/History workspace: all totals for a corp's properties for a year →
// seed ['propertyTotals', propId, year].
export const propertyTotalsByCorpQuery = (qc, corpId, year, properties) => ({
  queryKey: ['propertyTotalsByCorp', corpId, year],
  queryFn: async () => {
    const byProp = await listPropertyTotalsByYear(properties.map((p) => p.id), year);
    properties.forEach((p) => qc.setQueryData(['propertyTotals', p.id, year], byProp[p.id] ?? null));
    return byProp;
  },
});

// ---------------------------------------------------------------------------
// Hover / focus prefetchers — warm a destination's data the instant the user
// hovers (or keyboard-focuses) the thing they're about to click, so by click
// time it's already cached. prefetchQuery / ensureQueryData both respect
// staleTime, so repeated hovers don't spam the network.
// ---------------------------------------------------------------------------
export function usePrefetchers() {
  const qc = useQueryClient();
  const pf = (opts) => qc.prefetchQuery(opts);
  const ensure = (opts) => qc.ensureQueryData(opts);

  return {
    dashboard() {
      pf({ queryKey: ['searchIndex'], queryFn: fetchSearchIndex });
    },
    corporations() {
      pf({ queryKey: ['corporations'], queryFn: listCorporations });
      pf({ queryKey: ['corpCounts'], queryFn: listCorpCounts });
    },
    corporationsFinancials(year) {
      pf({ queryKey: ['corporations'], queryFn: listCorporations });
      pf({ queryKey: ['corpCounts'], queryFn: listCorpCounts });
      pf({ queryKey: ['corpRollups', year], queryFn: () => listCorpRollups(year) });
    },
    async corpLeases(corpId) {
      if (!corpId) return;
      pf({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
      const props = await ensure({ queryKey: ['properties', corpId], queryFn: () => listProperties(corpId) });
      await ensure(leasesByPropertiesQuery(qc, corpId, props || []));
    },
    async corpFinancials(corpId, year) {
      if (!corpId) return;
      pf({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
      const props = await ensure({ queryKey: ['properties', corpId], queryFn: () => listProperties(corpId) });
      await ensure(propertyTotalsByCorpQuery(qc, corpId, year, props || []));
    },
    async propertyLeases(propId) {
      if (!propId) return;
      pf({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
      const leases = await ensure({ queryKey: ['leases', propId], queryFn: () => listLeases(propId) });
      await ensure(escalationsByLeasesQuery(qc, propId, leases || []));
    },
    leaseDetail(leaseId) {
      if (!leaseId) return;
      pf({ queryKey: ['lease', leaseId], queryFn: () => getLease(leaseId) });
      pf({ queryKey: ['renewals', leaseId], queryFn: () => listRenewals(leaseId) });
    },
    propertyFinancials(propId, year) {
      if (!propId) return;
      pf({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
      pf({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year) });
      pf({ queryKey: ['expenseRecord', propId, year], queryFn: () => getExpenseRecord(propId, year) });
    },
    propertyHistory(propId) {
      if (!propId) return;
      pf({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
      pf({ queryKey: ['snapshots', propId], queryFn: () => listSnapshots(propId) });
      pf({ queryKey: ['expiredLeases', propId], queryFn: () => listExpiredLeases(propId) });
    },
  };
}
