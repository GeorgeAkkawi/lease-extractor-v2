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

// ---- Categories the landlord names (0099) -------------------------------------------
//
// When none of the fifteen above fit. THE CONSTRAINT: the list above is the union of Form
// 8825 and Schedule E, and FORM_LINES (cpaPackage.js) maps every key to a real line. You
// cannot invent a line on an IRS form. So a custom category is a NAMED WRITE-IN under
// "Other" — both forms end with a write-in line (8825 line 15, Sch E line 19) that asks you
// to LIST your own descriptions. It rolls up to `other` and supplies that line's text, which
// is why this makes the report better than it is now: one lumped "Other" becomes the
// itemization the form was asking for.
export const CUSTOM_PREFIX = 'custom:';

// ⚠ A custom key is RECOGNIZABLE BY SHAPE, and that is the design, not a shortcut. Validity
// is structural, so `isValidCategory` needs no list — which matters because it guards the
// bucket save (api.js) and the import's category resolution, and a version of this that had
// to be handed the custom list would silently discard the landlord's choice at any call site
// that forgot. Only DISPLAY needs the list, and even that degrades to a readable label
// (see below) rather than a blank.
export const isCustomCategory = (key) => typeof key === 'string' && key.startsWith(CUSTOM_PREFIX);

const CUSTOM_KEY_RE = /^custom:[a-z0-9]+(?:_[a-z0-9]+)*$/;

// 'Security patrol' → 'custom:security_patrol'. Derived from the label ONCE, at creation;
// the key is then frozen, because it is stored on every bucket and entity-ledger row that
// chose it and a rename must not orphan them.
export const customCategoryKey = (label) => {
  const slug = String(label || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60).replace(/_+$/, '');
  return slug ? CUSTOM_PREFIX + slug : null;
};

// The label a custom key carries when nobody handed us the list — de-slugged from the key
// itself. A caller that forgets `customs` therefore renders "Security patrol", never a blank
// chip reading "Set a tax category" over a category that IS set.
const labelFromCustomKey = (key) => {
  const s = key.slice(CUSTOM_PREFIX.length).replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
};

export const categoryLabel = (key, customs = []) => {
  if (isCustomCategory(key)) {
    return (customs || []).find((c) => c.key === key)?.label || labelFromCustomKey(key);
  }
  return BY_KEY.get(key)?.label || null;
};

export const isValidCategory = (key) => (isCustomCategory(key) ? CUSTOM_KEY_RE.test(key) : BY_KEY.has(key));

// Everything offerable in a picker: the form's own lines first, then the landlord's own.
// `custom: true` lets the UI group them under their own heading, so nobody mistakes a
// write-in for a line the IRS prints.
export const allCategories = (customs = []) => [
  ...EXPENSE_CATEGORIES,
  ...(customs || []).filter((c) => c?.key && c?.label).map((c) => ({ key: c.key, label: c.label, custom: true })),
];

// Which BUILT-IN key a category files under. A custom one is a write-in on the Other line,
// so it answers `other` — the single place that fact is encoded, so the CPA package, the
// 1099 sheet and the recoverability roll-up cannot disagree about where it lands.
export const filingCategory = (key) => (isCustomCategory(key) ? 'other' : key);

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
