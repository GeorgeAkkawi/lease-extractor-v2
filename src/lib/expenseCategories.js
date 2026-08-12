// The category an expense bucket rolls up to.
//
// THE LIST IS THE UNION OF FORM 8825 AND SCHEDULE E, and it stayed that way on purpose
// when the tax package was removed (George, 2026-08-12: "keep the list as is"). The
// package is gone, but the shape is still the right one: these are the categories a
// landlord's accountant already recognises, so a report handed over needs no
// translation, and nothing has to be re-categorized if one is ever wanted again.
//
// What is NO LONGER true: no export maps these to numbered form lines any more, and
// `depreciation` is gone with capitalizing (2026-08-12). Nothing could produce it and
// nothing could roll it up, so leaving it selectable would have offered the landlord a
// category that quietly reported nothing. ⚠ `categoryLabel` returns null for a retired
// key rather than throwing, and `categoryFor` treats it as unanswered — so a bucket
// that chose it before the removal shows the gold "Set a category" chip and gets asked
// again, which is the honest outcome and the one this file already handles.
//
// IT LIVES IN JS, NOT IN A CHECK CONSTRAINT OR AN ENUM — matching how this codebase
// already does registries (FEATURES in features.js, NOTIFY_TYPES in notifyPrefs.js).
// A CHECK would mean a migration every time the list is refined, and would reject a row
// the app itself considers valid.
//
// NOTHING HERE BILLS ANYTHING. A category is reporting vocabulary: which heading a dollar
// rolls up to. What a TENANT is charged is decided entirely by cam_line_items.billable and
// the pro-rata share — untouched by this file. So a mis-categorized bucket produces a wrong
// report and never a wrong invoice. ⚠ ONE EXCEPTION, since 2026-08-12: `distribution` does
// not bill anything either, but it decides whether a line is counted as a cost AT ALL. It
// is the only key here that changes an arithmetic rather than a label.

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
  { key: 'other',         label: 'Other' },
  // ⚠ NOT AN EXPENSE, and `ownerCapital` is what keeps it out of every expense subtotal.
  // Retiring the entity ledger (2026-08-12) collapsed owner draws into this list — one
  // register, one set of buckets, which is what the landlord asked for. What it must NOT
  // collapse is the arithmetic: a distribution reduces equity and is not a cost of the
  // building, so it is carried here and reported on its own line beneath the net.
  //
  // It is BILLING-INERT by construction and that is not luck. A distribution is written
  // as a `cam_line_items` row with `billable = false`, and syncCamTotal (api.js) filters
  // those out of `cam_total` — so it never reaches expense_records, v_property_totals,
  // a tenant share or an invoice. NOI is identical with or without it.
  { key: 'distribution',  label: 'Owner distribution', ownerCapital: true },
];

const BY_KEY = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

// ONE predicate decides what an expense subtotal may contain, so the "What it cost you"
// table and the Income-and-expenses workbook cannot disagree about whether a draw is a
// cost — the exact class of divergence CLAUDE.md §3 is about. Both read it through
// `recoverabilityRows`, which returns owner rows in `owner` and never in `totals`;
// neither re-derives the rule.
//
// There is deliberately NO income-side counterpart. Money the owner puts IN has no
// amount-bearing home — it files as a `transfer`, which records the bank line and counts
// it nowhere (otherIncome.js states the refusal), so nothing needs to exclude it.
//
// A custom category can never be one of these: `filingCategory` files every custom key
// under `other`, and the landlord names write-ins, not accounting primitives.
export const isOwnerCategory = (key) => BY_KEY.get(key)?.ownerCapital === true;

// ---- Categories the landlord names (0099) -------------------------------------------
//
// When none of the built-ins above fit. It is a NAMED WRITE-IN under "Other": it rolls up
// to `other` and supplies that line's text, so one lumped "Other" becomes an itemization.
// (The rule predates the tax package and outlived it — the package is gone as of
// 2026-08-12, the write-in shape is still the right one for a category nobody planned for.)
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
// the key is then frozen, because it is stored on every bucket that chose it and a rename
// must not orphan them.
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
// so it answers `other` — the single place that fact is encoded, so the recoverability
// roll-up and the Income-and-expenses workbook cannot disagree about where it lands.
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

export const defaultCategoryFor = (label) => DEFAULTS[bucketKey(label)] || null;

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
