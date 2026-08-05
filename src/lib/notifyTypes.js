// The Overview feed, sorted into one column per kind of thing.
//
// George, 2026-07-30: "compact row and i want you to sort by notification type — create a
// column for each notification type — rent escalation, insurance, renewal, corporation
// filing etc. (make sure for every notification theres one)."
//
// That last clause is the load-bearing one, and it's why this is a REGISTRY rather than a
// switch buried in the page: every alert `focus` produced by buildAlerts and every stored
// notification `kind` has to land somewhere. notifyTypes.test.js reads the focuses out of
// alerts.js and the kinds out of api.js and asserts each one maps to a real column, so
// adding a new alert type without giving it a home fails the suite rather than silently
// dropping it into a catch-all nobody looks at.
//
// The `other` column is the safety net for exactly that case: it renders ONLY when
// something unmapped lands in it, so an unclassified row is visible instead of lost.

// Columns in display order. `focuses` claims computed alerts, `kinds` claims stored
// notifications — one grouping, both sources, so a renewal PROMPT sits in the same column
// as the renewal-notice deadline that prompted it.
export const NOTIFY_COLUMNS = [
  {
    key: 'escalation',
    label: 'Rent escalations',
    focuses: ['escalation'],
    kinds: ['escalation_applied'],
  },
  {
    key: 'renewal',
    label: 'Renewals',
    focuses: ['renewal'],
    kinds: ['renewal_decision', 'renewal_applied', 'renewal_declined', 'renewal_approaching'],
  },
  {
    key: 'termination',
    label: 'Lease endings',
    focuses: ['termination'],
    kinds: [],
  },
  {
    key: 'signature',
    // Both halves of a document that is waiting on the LANDLORD: the tenant has signed and
    // it needs his countersignature, or it is signed by both and was never applied. An
    // envelope still out with the tenant raises nothing — he can't act on it — so this
    // column only ever holds work he can finish.
    label: 'Signatures',
    focuses: ['signature_countersign', 'signature_apply'],
    kinds: [],
  },
  {
    key: 'insurance',
    // One heading for the whole life of a certificate: none on file → requested →
    // chased → on file and expiring. Same tenant, same conversation.
    label: 'Insurance',
    focuses: ['insurance', 'insurance_chase', 'insurance_missing'],
    kinds: ['insurance_request'],
  },
  {
    key: 'money',
    // The three ledger signals: a statement not imported, a tenant missing from one that
    // was, and a free-rent window about to end (full billing resumes).
    label: 'Rent & payments',
    focuses: ['statement_reminder', 'missing_payment', 'abatement'],
    kinds: [],
  },
  {
    key: 'contract',
    label: 'Service contracts',
    // ⚠ notifyTypes.test.js regex-scans alerts.js for every `focus:` it emits and fails if
    // one is unmapped — a new contract alert type must be listed here or the suite reds.
    focuses: ['contract', 'contract_notice', 'contract_escalation'],
    kinds: ['contract_renewal'],
  },
  {
    key: 'filing',
    label: 'Corporate filings',
    focuses: ['annual_report'],
    kinds: [],
  },
];

// Rendered only when something lands in it — see the header note.
export const OTHER_COLUMN = { key: 'other', label: 'Other', focuses: [], kinds: [] };

const BY_FOCUS = {};
const BY_KIND = {};
NOTIFY_COLUMNS.forEach((c) => {
  c.focuses.forEach((f) => { BY_FOCUS[f] = c.key; });
  c.kinds.forEach((k) => { BY_KIND[k] = c.key; });
});

// Which column a feed row belongs to. Takes a buildFeed row ({ type, item }) or a bare
// alert/notification, so callers and tests can pass whichever they have.
export function columnForRow(row) {
  const item = row?.item ?? row;
  if (!item) return OTHER_COLUMN.key;
  return (item.focus ? BY_FOCUS[item.focus] : BY_KIND[item.kind]) || OTHER_COLUMN.key;
}

// Split the ordered feed into columns, preserving buildFeed's urgency sort inside each.
// Every registered column comes back whether or not it holds anything — George's pick:
// the seven headings always sit in the same place, and an empty one reads "All clear",
// so the board's shape doesn't move as the week goes on.
export function groupFeed(feed = []) {
  const cols = [...NOTIFY_COLUMNS, OTHER_COLUMN].map((c) => ({ ...c, rows: [] }));
  const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
  feed.forEach((row) => { byKey[columnForRow(row)].rows.push(row); });
  // `other` earns its place only by holding something unmapped.
  return cols.filter((c) => c.key !== OTHER_COLUMN.key || c.rows.length > 0);
}

// What a compact row says on its one line. Inside the "Rent escalations" column,
// "Rent escalation — Five Points Wings" is just "Five Points Wings" — the column heading
// already carried the type, and repeating it is what made the old rows too tall to scan.
//
// Every alert and notification title in the app is built as "{what} — {who}", so the text
// after the LAST em dash is the subject. The renewal prompt is the one exception (it's
// phrased as a question), and it's stripped by name.
export function rowSubject(row) {
  const item = row?.item ?? row;
  if (!item) return '';
  if (item.tenant) return item.tenant;
  if (item.contract_name) return item.contract_name;
  const title = String(item.title || '');
  const q = title.match(/^Is (.+) renewing\?$/);
  if (q) return q[1];
  const i = title.lastIndexOf('—');
  const tail = i >= 0 ? title.slice(i + 1).trim() : '';
  return tail || title;
}
