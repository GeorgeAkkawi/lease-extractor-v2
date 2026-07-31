// Slice 2 — the tax category an expense bucket rolls up to.
//
// THE LIST IS THE UNION OF FORM 8825 AND SCHEDULE E, on purpose. George's filing form
// is unsettled ("my CPA handles it"), and the two forms differ only in a few lines —
// 8825 carries Wages and folds management fees into Other; Schedule E carries
// Management fees and Supplies and splits interest two ways. One list serves both, and
// the export names whichever line the CPA actually wants. Building toward ONE form
// would mean re-categorizing every bucket the day the entity's filing changes.
//
// IT LIVES IN JS, NOT IN A CHECK CONSTRAINT OR AN ENUM — matching how this codebase
// already does registries (FEATURES in features.js, NOTIFY_TYPES in notifyPrefs.js).
// A CHECK would mean a migration every time the list is refined, and would reject a row
// the app itself considers valid.
//
// NOTHING HERE BILLS ANYTHING. A category is reporting vocabulary: which line of a tax
// form a dollar rolls up to. What a TENANT is charged is decided entirely by
// cam_line_items.billable and the pro-rata share — untouched by this file. So a
// mis-categorized bucket produces a wrong report and never a wrong invoice.

// key is stable and stored; label is what the user reads. Order is the order shown.
export const EXPENSE_CATEGORIES = [
  { key: 'advertising',   label: 'Advertising' },
  { key: 'auto_travel',   label: 'Auto and travel' },
  { key: 'cleaning',      label: 'Cleaning and maintenance' },
  { key: 'commissions',   label: 'Commissions' },
  { key: 'management',    label: 'Management fees' },
  { key: 'insurance',     label: 'Insurance' },
  { key: 'interest',      label: 'Interest' },
  { key: 'legal',         label: 'Legal and professional' },
  { key: 'taxes',         label: 'Real estate taxes' },
  { key: 'repairs',       label: 'Repairs' },
  { key: 'supplies',      label: 'Supplies' },
  { key: 'utilities',     label: 'Utilities' },
  { key: 'wages',         label: 'Wages' },
  { key: 'depreciation',  label: 'Depreciation' },
  { key: 'other',         label: 'Other' },
];

const BY_KEY = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

export const categoryLabel = (key) => BY_KEY.get(key)?.label || null;
export const isValidCategory = (key) => BY_KEY.has(key);

// One bucket identity rule, used by the unique index (lower(btrim(label))), the runtime
// Map and every lookup here — so "Snow removal", "snow removal" and "Snow removal "
// are one bucket and can never hold two different categories.
export const bucketKey = (label) => String(label || '').trim().toLowerCase();

// Sensible categories for the labels the app itself proposes — the 18 CAM_KEYWORDS
// built-ins plus the two the app generates (the management fee from 0067's rent_pct
// entry, and Roof). A brand-new user therefore gets a usable report before configuring
// anything, and every one of these stays editable.
//
// These are DEFAULTS, not decisions, and the difference is tracked (see categoryFor's
// `source`): a bucket a human named — "Other", "IL DPT REV", "Liana" — has no default
// and shows as uncategorized until answered. That asymmetry IS the forcing function.
// Anything a person invented is the thing worth asking about.
const DEFAULTS = {
  landscaping:        'cleaning',
  'snow removal':     'cleaning',
  janitorial:         'cleaning',
  'pest control':     'cleaning',
  cleaning:           'cleaning',
  maintenance:        'cleaning',
  'hvac service':     'repairs',
  plumbing:           'repairs',
  'elevator service': 'repairs',
  paving:             'repairs',
  'parking lot':      'repairs',
  roof:               'repairs',
  utilities:          'utilities',
  electric:           'utilities',
  water:              'utilities',
  sewer:              'utilities',
  'trash removal':    'utilities',
  'waste removal':    'utilities',
  'management fee':   'management',
  insurance:          'insurance',
  // Deliberately absent: Security. A security service has no line of its own on either
  // form and lands on Cleaning or Other depending on the CPA — exactly the judgement
  // call this file must not make silently. It shows as uncategorized and gets asked.
};

// Buckets where a large spend is plausibly a capital improvement rather than a repair —
// what Slice 5 reads to decide whether to offer "capitalize as an asset" at review.
// Advisory only; nothing acts on it yet.
const CAPITAL_PRONE = new Set(['roof', 'hvac service', 'paving', 'parking lot', 'plumbing', 'elevator service']);

export const defaultCategoryFor = (label) => DEFAULTS[bucketKey(label)] || null;
export const isCapitalProne = (label) => CAPITAL_PRONE.has(bucketKey(label));

/**
 * The category in force for a bucket, and where it came from.
 *   saved   — a human chose it. Authoritative.
 *   default — the built-in mapping for a label the app proposed. Honest, not chosen.
 *   null    — nobody has said. Surfaced as a figure that wants an answer, NEVER
 *             absorbed into "Other", which is the whole point of the slice.
 */
export function categoryFor(label, buckets = []) {
  const key = bucketKey(label);
  const saved = buckets.find((b) => bucketKey(b.label) === key);
  if (saved?.category && isValidCategory(saved.category)) {
    return { category: saved.category, source: 'saved' };
  }
  const def = defaultCategoryFor(label);
  return def ? { category: def, source: 'default' } : { category: null, source: null };
}

// The roll-up itself lives in recoverability.js (Slice 3). It began here as a
// spent-only `summarizeByCategory`, and Slice 3's version is a strict superset — same
// grouping, same "uncategorized is never Other" refusal, plus what tenants paid back.
// Keeping both would be two implementations of one grouping rule, which CLAUDE.md §3
// says always drift; the invariants moved to that suite rather than being dropped.
