// "Who has occupied this building" — the History page's tenant record, one card per
// tenant, current and former.
//
// George, 2026-07-30: "i like a story per tenant maybe put it under a property just so we
// know where we are. but also filter out some of the noise."
//
// THE PROBLEM THIS SOLVES. The old timeline was a flat table of history_events under a
// heading promising tenant history — and it was nearly always empty, because every event
// type is a side effect of some OTHER action (applying a renewal, reconciling CAM,
// importing a statement). Nothing writes an event when a lease is created or when a
// tenant leaves — the two moments a landlord most expects to see. And when it did fill,
// it filled with CAM reconciles and statement imports, which carry no lease_id and no
// tenant_name at all, so they rendered "—" in the very column the heading pointed at.
//
// THE FIX NEEDS NO NEW WRITES. The lease rows already hold the bookends:
//   • leases.lease_start                       → "Moved in"
//   • leases.lease_termination_date            → "Term ends" / "Term ended"
//   • expired_leases.lease_end + .status       → "Left — Renewed / Vacated / Terminated"
// Deriving those makes every card populated on day one, with zero DB writes, no
// migration and no risk of double-recording (a real tenant_removed event would duplicate
// the derivation).

// Events that belong in a tenant's story — things that happened TO the tenancy.
export const STORY_EVENTS = [
  'tenant_assigned', 'term_extended', 'premises_resized', 'renewal_confirmed', 'renewal_declined',
  'renewal_reopened', 'rent_abated', 'rent_stepped', 'lease_created', 'lease_replaced',
  'insurance_requested',
];

// Bookkeeping — things that happened to the BOOKS. Real records worth keeping, but they
// are about the year's money, not about who lived here, so they get their own folded log.
// The two statement events carry neither lease_id nor tenant_name, so they could never
// have belonged to a tenant's story in the first place.
export const LEDGER_EVENTS = [
  'estimate_set', 'cam_reconciled', 'cam_refunded', 'cam_reconcile_undone',
  'cam_refund_reopened', 'statement_imported', 'statement_import_undone',
];

const STORY_SET = new Set(STORY_EVENTS);

// An unknown type falls to the ledger log rather than vanishing — same principle as the
// notification board's `other` column.
export const isStoryEvent = (type) => STORY_SET.has(type);

const iso = (v) => (v ? String(v).slice(0, 10) : null);
// history_events carries both a business date and a row stamp; the business date is what
// the timeline shows, so it must also be what the timeline SORTS by. The old table sorted
// by created_at while displaying event_date, which put a renewal backdated to 2008 at the
// top of the list reading "2008".
const evDate = (e) => iso(e?.event_date) || iso(e?.created_at);

const OUTCOME_VERB = {
  Renewed: 'Renewed into a new term',
  Terminated: 'Lease terminated',
  Vacated: 'Vacated',
};

// Build the per-tenant cards.
//
//   leases   — the property's current leases (listLeases)
//   expired  — its archived prior terms (listExpiredLeases)
//   events   — its history_events (listHistoryEvents)
//   today    — YYYY-MM-DD, so "term ends" vs "term ended" is the landlord's own calendar
//
// Current tenants first (soonest term end first, so what needs attention leads), then
// former tenants most-recently-ended first.
export function buildTenantStories({ leases = [], expired = [], events = [], today } = {}) {
  const now = iso(today) || '';
  const story = (events || []).filter((e) => isStoryEvent(e.type));

  // A current tenant's events attach by lease_id. A former tenant's lease row is gone
  // (expired_leases is a copy; history_events.lease_id is ON DELETE SET NULL), so those
  // attach by the tenant_name denormalized onto the event in migration 0040.
  const byLease = {};
  const byName = {};
  story.forEach((e) => {
    if (e.lease_id) (byLease[e.lease_id] ||= []).push(e);
    if (e.tenant_name) (byName[e.tenant_name] ||= []).push(e);
  });
  // Oldest → newest: a story reads forward.
  const chron = (list) => [...(list || [])].sort((a, b) => String(evDate(a)).localeCompare(String(evDate(b))));

  const current = (leases || []).map((l) => {
    const end = iso(l.lease_termination_date);
    const timeline = [];
    if (iso(l.lease_start)) {
      timeline.push({ date: iso(l.lease_start), type: 'moved_in', label: 'Moved in', description: 'Lease term begins', synthetic: true });
    }
    (byLease[l.id] || []).forEach((e) => timeline.push({ date: evDate(e), type: e.type, description: e.description, id: e.id }));
    if (end) {
      const past = now && end < now;
      timeline.push({
        date: end,
        type: past ? 'term_ended' : 'term_ends',
        label: past ? 'Term ended — still in place' : 'Term ends',
        description: past ? 'The tenant is holding over past the term end' : null,
        synthetic: true,
      });
    }
    return {
      key: `lease:${l.id}`,
      leaseId: l.id,
      tenant: l.tenant_name || 'Untitled tenant',
      status: 'current',
      // A lease flagged inactive is an "outdated / needs extension" tenancy — still in
      // place, still owing rent, so it stays a CURRENT tenant (the same rule the property
      // card and the Leases page follow) and simply says so.
      needsExtension: l.is_active === false,
      sf: Number(l.square_footage) || 0,
      rent: Number(l.base_rent) || 0,
      address: l.premises_address || null,
      start: iso(l.lease_start),
      end,
      holdover: !!(end && now && end < now),
      outcome: null,
      note: null,
      leaseText: l.lease_text || null,
      events: timeline.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  });

  const former = (expired || []).map((e) => {
    const end = iso(e.lease_end);
    const timeline = [];
    if (iso(e.lease_start)) {
      timeline.push({ date: iso(e.lease_start), type: 'moved_in', label: 'Moved in', description: 'Lease term begins', synthetic: true });
    }
    (byName[e.tenant_name] || []).forEach((ev) => timeline.push({ date: evDate(ev), type: ev.type, description: ev.description, id: ev.id }));
    if (end) {
      timeline.push({
        date: end,
        type: 'left',
        label: OUTCOME_VERB[e.status] || 'Left',
        description: e.note || null,
        synthetic: true,
      });
    }
    return {
      key: `expired:${e.id}`,
      expiredId: e.id,
      tenant: e.tenant_name || 'Untitled tenant',
      status: 'former',
      needsExtension: false,
      sf: Number(e.sf) || 0,
      rent: Number(e.base_rent) || 0,
      address: null,
      start: iso(e.lease_start),
      end,
      holdover: false,
      outcome: e.status || null,
      note: e.note || null,
      leaseText: e.lease_text || null,
      events: timeline.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    };
  });

  const noEnd = '9999-12-31'; // a lease with no term end sorts last among current tenants
  current.sort((a, b) => (a.end || noEnd).localeCompare(b.end || noEnd) || a.tenant.localeCompare(b.tenant));
  former.sort((a, b) => String(b.end || '').localeCompare(String(a.end || '')) || a.tenant.localeCompare(b.tenant));
  return [...current, ...former];
}

// Everything that didn't belong to a tenant's story, newest first — the folded
// "Bookkeeping log" under the cards.
export function ledgerEvents(events = []) {
  return (events || [])
    .filter((e) => !isStoryEvent(e.type))
    .sort((a, b) => String(evDate(b)).localeCompare(String(evDate(a))));
}
