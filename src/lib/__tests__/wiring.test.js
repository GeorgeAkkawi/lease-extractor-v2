// The rules in CLAUDE.md, in a form that can't rot.
//
// George, 2026-08-21: *"we need to do an audit to find all the little bugs like this for when we
// start onboarding new clients i dont want these things to happen."* — after clicking an answer on
// the Ledger and watching the box not change, because the money HAD moved and only a 3px ring said
// so. Nothing was broken in the code. The defect was a real state change with no legible
// consequence, and no diff review can find that.
//
// ⚠ THIS FILE READS THE SOURCE, it does not test a hand-written list. That is the whole point and
// it is not a new idea here: `notifyTypes.test.js` has done it since the notification columns
// shipped ("make sure for every notification theres one"). CLAUDE.md documents roughly eight
// invariants of that shape — §3 mirrors, §4 registries, §6 query keys — and until now exactly one
// was checked. Everything below is the same mechanism pointed at the rest.
//
// ⚠ EVERY SWEEP CARRIES A NON-VACUITY GUARD (`expect(found.length).toBeGreaterThan(N)`). A sweep
// whose regex silently stops matching passes forever while asserting nothing, which is worse than
// no test at all: it states out loud that the rule is being kept.
//
// ⚠ THE `KNOWN` LISTS ARE A BACKLOG, NOT AN EXEMPTION. Each one is a real hit found on
// 2026-08-21, left failing-but-recorded so George can pick what gets fixed (his call, per the
// audit plan) while the invariant still cannot get WORSE in the meantime. Emptying a KNOWN list
// is the fix landing. Adding to one should need a reason on the line.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Every .js under src/, excluding tests — the app as it actually ships. */
function appFiles(dir = 'src', out = []) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === '__tests__' || e.name === 'node_modules') continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) appFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const APP = appFiles().map((p) => ({ p, src: read(p) }));
const uniq = (a) => [...new Set(a)];

/** The test sources too — used only where "referenced by a test" is itself the answer. */
function testFiles(dir = 'src', out = []) {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) testFiles(p, out);
    else if (e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}
const allTestSrc = () => testFiles().map(read).join('\n');

// ── 1. An alert that lands somewhere it isn't explained ─────────────────────────────────────
//
// ⚠ THE WORST FAILURE IN THIS FILE, and the only one that is visibly broken rather than merely
// inert. `LeaseDetailPage` renders its "Why you're here" callout on `{focus && (…)}` — ANY focus —
// but every line inside it is `focus === '<one of four>' && '…'`. A focus that reaches the page
// and isn't one of those four draws a bordered, accent-coloured box containing an empty bold
// title and an empty muted line. A new client clicks a notification and gets a broken box.
describe('every alert focus that reaches the lease page is explained there', () => {
  const alerts = read('src/lib/alerts.js');
  const dash = read('src/pages/DashboardPage.js');
  const lease = read('src/pages/LeaseDetailPage.js');

  // Every focus buildAlerts can produce.
  const produced = uniq([...alerts.matchAll(/focus:\s*'([a-z_]+)'/g)].map((m) => m[1]));

  // `goToAlert` sends some of them elsewhere (the Ledger, the Contracts tab, the corporations
  // grid); read that list off the function itself rather than restating it here, so a route
  // moving cannot leave this test asserting yesterday's map.
  const goTo = dash.slice(dash.indexOf('function goToAlert'));
  const elsewhere = new Set(
    [...goTo.slice(0, goTo.indexOf('\n  }')).matchAll(/a\.focus === '([a-z_]+)'/g)].map((m) => m[1])
  );
  // …everything else with a lease_id falls through to `/leases/…/:leaseId?focus=`.
  const reachesLease = produced.filter((f) => !elsewhere.has(f));

  it('found the real sets (non-vacuity)', () => {
    expect(produced.length).toBeGreaterThan(12);
    expect(elsewhere.size).toBeGreaterThan(4);
    expect(reachesLease.length).toBeGreaterThan(3);
  });

  // KNOWN, 2026-08-21 — six focuses reach the lease page and are named by neither registry.
  const KNOWN = [
    'abatement',             // alerts.js:588
    'insurance_chase',       // alerts.js:420
    'insurance_missing',     // alerts.js:458 (the lease_id-bearing variant)
    'signature_countersign', // alerts.js:528
    'signature_apply',       // alerts.js:539
    'signature_declined',    // alerts.js:561
  ];

  // ⚠ BOTH HALVES, not the box as a whole. The callout is a bold title line and a muted body
  // line, each its own list of `focus === '…' &&` branches — so a focus named in one and not the
  // other still renders half an empty box. Checking the box as a unit let that through; the
  // non-vacuity run caught it (removing the `termination` TITLE alone kept the test green).
  it('the callout names every focus in BOTH its title and its body — or it draws an empty box', () => {
    const box = lease.slice(lease.indexOf('{focus && ('), lease.indexOf('{lease.extraction_status'));
    const title = box.slice(box.indexOf('alert-title'), box.indexOf('</strong>'));
    const body = box.slice(box.indexOf('className="muted"'));
    const namedIn = (part) => new Set([...part.matchAll(/focus === '([a-z_]+)'/g)].map((m) => m[1]));
    for (const [what, part] of [['title', title], ['body', body]]) {
      const named = namedIn(part);
      expect(named.size, `the ${what} regex found nothing`).toBeGreaterThan(2);
      expect(reachesLease.filter((f) => !named.has(f) && !KNOWN.includes(f)), `unnamed in the ${what}`).toEqual([]);
    }
  });

  it('each one also has somewhere to scroll to', () => {
    const map = lease.match(/const refByFocus = \{([^}]*)\}/)?.[1] || '';
    const handled = new Set([...map.matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
    expect(handled.size).toBeGreaterThan(2);
    expect(reachesLease.filter((f) => !handled.has(f) && !KNOWN.includes(f))).toEqual([]);
  });
});

// ── 2 & 3. Query keys, both directions ──────────────────────────────────────────────────────
//
// A key READ by a screen that no write ever invalidates is a screen showing last week's figures.
// A key INVALIDATED by a write that no screen reads is a line of code doing nothing — and in this
// codebase it has twice been a near-miss typo for the real neighbour, sitting in a list where
// every other entry is correct.
//
// ⚠ THE INDIRECTION IS THE HARD PART, and getting it wrong reports ~5 false positives. Keys reach
// `useQuery` three ways here: written inline; through a factory spread (`...leasesByPropertiesQuery(…)`,
// prefetch.js); and through `invalidate.js`, whose keys sit in `const keys = [ … ]` arrays consumed
// by a `for (const queryKey of keys)` loop, so no `invalidateQueries({ queryKey: […] })` literal
// exists for any of them.
describe('query keys are wired in both directions', () => {
  // ⚠ THREE SHAPES, and missing any one of them reports false positives. Verified 2026-08-21
  // against the four keys a naive sweep flagged (`addendums`, `searchIndex`, `extractionRaw`,
  // `leaseStatedEstimate`) — every one was real and invalidated through a shape below.
  //   a) direct:   invalidateQueries({ queryKey: ['x'] })
  //   b) ternary:  invalidateQueries({ queryKey: id ? ['x', id] : ['x'] })
  //   c) LOOPED:   ['x','y','z'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }))
  //                for (const n of ['x','y']) qc.invalidateQueries({ queryKey: [n] })
  //      …where no per-key literal exists at all. `invalidate.js` is built entirely of (c).
  const DIRECT = /(?:invalidateQueries|removeQueries|resetQueries|setQueryData)\s*\(\s*\{\s*queryKey:\s*[^[\n]{0,80}\[\s*'([a-zA-Z]+)'/g;
  const STRING_ARRAY = /\[\s*((?:'[a-zA-Z]+'\s*,\s*)+'[a-zA-Z]+')\s*\]/g;

  const freshened = new Set();
  const readKeys = new Map(); // key -> [file:line]

  for (const { p, src } of APP) {
    // Every array literal in invalidate.js is a key list by construction — including the
    // `for (const name of [...])` at :105, whose three names have no literal of their own.
    if (p.endsWith('lib/invalidate.js')) {
      for (const arr of src.matchAll(/\[([^\][]*)\]/g)) {
        for (const k of arr[1].matchAll(/'([a-zA-Z]+)'/g)) freshened.add(k[1]);
      }
      continue;
    }
    for (const m of src.matchAll(DIRECT)) freshened.add(m[1]);
    // (c) — a bare string array is a key list only if it is fed straight into an invalidation.
    for (const m of src.matchAll(STRING_ARRAY)) {
      if (!/invalidateQueries/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 140))) continue;
      for (const k of m[1].matchAll(/'([a-zA-Z]+)'/g)) freshened.add(k[1]);
    }
    // A `queryKey:` that is NOT inside one of those calls is a read — inline or in a factory.
    for (const m of src.matchAll(/queryKey:\s*\[\s*'([a-zA-Z]+)'/g)) {
      const before = src.slice(Math.max(0, m.index - 120), m.index);
      if (/(invalidateQueries|removeQueries|resetQueries|setQueryData|cancelQueries)\s*\(\s*\{?\s*$/.test(before)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      if (!readKeys.has(m[1])) readKeys.set(m[1], []);
      readKeys.get(m[1]).push(`${p}:${line}`);
    }
  }

  it('found the real sets (non-vacuity)', () => {
    expect(freshened.size).toBeGreaterThan(25);
    expect(readKeys.size).toBeGreaterThan(40);
  });

  // KNOWN, 2026-08-21 — read by a screen, invalidated by nothing.
  const STALE_OK = {
    dashboardPrefs: 'kept fresh by setQueryData in DisplaySettings.js — deliberate',
    enabledFeatures: 'kept fresh by setQueryData in DisplaySettings.js — deliberate',
    insurance: 'invalidated through a local variable in InsuranceVault.js, so no literal appears',
    senderEmails: 'has no write path in api.js at all — nothing can change it',
    portfolioTotals: 'BACKLOG: the Overview band. Nothing invalidates it.',
    propertyTotalsByCorp: 'BACKLOG: its two sibling batch keys are in invalidate.js; this one was missed',
    escalationsByLeases: 'BACKLOG: settleLeaseScheduleChange covers escalations + escalationsByProperty, not this',
    corpProperties: 'BACKLOG: the Sidebar never unmounts, so it never refetches — the sidebarLeases shape again',
    billedTenants: 'BACKLOG: tenant count beside a contract resync',
    envelopeEvents: 'BACKLOG: the signature audit trail, child of the invalidated `envelopes`',
    envelopeSigners: 'BACKLOG: same',
    incomeExpense: 'BACKLOG: built on demand by the export modal',
    portfolioSnapshot: 'BACKLOG: Ask Amlak\'s cached portfolio facts',
  };

  it('every key a screen reads is refreshed by something', () => {
    const stale = [...readKeys.keys()].filter((k) => !freshened.has(k) && !(k in STALE_OK));
    expect(stale, 'a screen reading these will show stale figures until a hard refresh').toEqual([]);
  });

  // KNOWN, 2026-08-21 — invalidated, but no screen reads it.
  const DEAD_OK = {
    propertyEscalations: 'BACKLOG: near-miss for the live `escalationsByProperty` (Layout.js:41, EscalationScheduleEditor.js:74)',
    history: 'BACKLOG: near-miss for the live `historyEvents` (PropertyAnnouncementsModal.js:235)',
  };

  it('every key a write invalidates is read by some screen', () => {
    const dead = [...freshened].filter((k) => !readKeys.has(k) && !(k in DEAD_OK));
    expect(dead, 'invalidating these repaints nothing — usually a typo for a real neighbour').toEqual([]);
  });
});

// ── 4. An export nobody calls ───────────────────────────────────────────────────────────────
//
// The shape that matters here is a WRITE path with no reader. `statement_lines.disposition` was
// stored from 0076 and for two weeks nothing rendered it — `listDecidedLines` had zero importers
// — so a line the landlord filed left the screen forever. Nothing failed; the feature was simply
// only half there.
//
// ⚠ Referenced-only-by-tests is the sharper smell of the two and is deliberately NOT failed here:
// those exports have passing tests, so they LOOK covered while no product code calls them. They
// are listed in the audit report instead, because "delete it or wire it up" is a judgement call.
describe('every api.js export has a caller', () => {
  const api = read('src/lib/api.js');
  const names = uniq([...api.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
  const rest = appFiles().filter((f) => !f.endsWith('lib/api.js')).map(read).join('\n')
    + '\n' + allTestSrc();

  it('found the real set (non-vacuity)', () => expect(names.length).toBeGreaterThan(150));

  // KNOWN, 2026-08-21 — referenced NOWHERE in src, product code or tests.
  // ⚠ Two of these read as MISSING UI rather than dead code, and are called out in the report:
  // `markNotificationRead` (nothing can mark a notification read) and `deleteInvoice`.
  const KNOWN = [
    'listAnnualReports', 'listAbatementsForLeases', 'createLeaseEstimate', 'INVOICE_DRIFT_DUST',
    'removeStorageObjects', 'listContractEscalationsFor', 'updateEscalation',
    'listScheduledEscalationsForProperty', 'deleteCustomCategory', 'listExpenseSpendByProperty',
    'deleteInvoice', 'listAdjustmentsByLeases', 'markNotificationRead',
  ];

  it('is referenced by something', () => {
    const orphans = names.filter((n) => !KNOWN.includes(n) && !new RegExp(`\\b${n}\\b`).test(rest));
    expect(orphans, 'an export with no caller is usually half a feature').toEqual([]);
  });
});

// ── 5. A module with no backfill migration is invisible in production ───────────────────────
//
// ⚠ THE ONE MOST DIRECTLY ABOUT ONBOARDING. `enabled_features` is NULL for a fresh account, which
// `isFeatureOn` reads as "everything on" — but the moment a client uses the picker it becomes an
// explicit ARRAY, and a key added to FEATURES later is absent from that array, which reads as OFF.
// ⚠ THE DEMO CANNOT CATCH THIS: it seeds no `user_preferences` row, so it runs the NULL path and
// shows the module happily while production hides it. That is exactly how `announcements` shipped
// invisible on 2026-08-04.
describe('every optional module can actually be seen in production', () => {
  const keys = [...read('src/lib/features.js').matchAll(/\{\s*key:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const migrations = readdirSync(join(ROOT, 'supabase/migrations'));
  const sql = migrations.map((f) => read(`supabase/migrations/${f}`)).join('\n');

  it('found the real set (non-vacuity)', () => {
    expect(keys.length).toBeGreaterThan(3);
    expect(migrations.length).toBeGreaterThan(50);
  });

  // 0043 created the column; the three modules that existed then are in every stored array
  // already, so only keys added AFTER the picker shipped need a backfill.
  const PRE_PICKER = ['insurance', 'contracts', 'ledger'];

  it('a module added after the feature picker ships a backfill migration', () => {
    const missing = keys.filter((k) => !PRE_PICKER.includes(k) && !sql.includes(`'${k}'`));
    expect(missing, 'these read as OFF for every existing client — copy 0084 and change the key').toEqual([]);
  });
});

// ── 6. A view the demo does not mirror is behaviour the suite passes over ───────────────────
//
// CLAUDE.md §3: the mock hand-implements the SQL views, so a view change without a matching mock
// change means the whole suite passes over something that is broken live. That is the `not()`
// incident, and the comment at mockClient.js:155 is its headstone.
describe('the demo mock mirrors every SQL view', () => {
  const sql = readdirSync(join(ROOT, 'supabase/migrations'))
    .map((f) => read(`supabase/migrations/${f}`)).join('\n');
  const views = uniq([...sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?(v_[a-z_]+)/gi)].map((m) => m[1]));
  const mock = read('src/lib/demo/mockClient.js');

  it('found the real set (non-vacuity)', () => expect(views.length).toBeGreaterThan(2));

  it('has a hand-written counterpart for each', () => {
    expect(views.filter((v) => !mock.includes(v))).toEqual([]);
  });
});

// ── 7. The marketing site and the product must look like one company ───────────────────────
//
// CLAUDE.md: `site/site.css` is a deliberate second copy of ONLY the app's `:root` block. Move the
// palette in one and not the other and the page a client lands on stops matching the product it
// sells. The site legitimately carries EXTRA tokens (--wrap, --shadow-lift) and omits some it has
// no use for, so only the SHARED keys are compared.
describe('the site mirrors the app design tokens', () => {
  const tokens = (css) => {
    const root = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')));
    return Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
  };
  const app = tokens(read('src/App.css'));
  const site = tokens(read('site/site.css'));

  it('found both blocks (non-vacuity)', () => {
    expect(Object.keys(app).length).toBeGreaterThan(15);
    expect(Object.keys(site).length).toBeGreaterThan(10);
  });

  it('agrees on every token they share', () => {
    const drift = Object.keys(app).filter((k) => k in site && app[k] !== site[k]).map((k) => `${k}: app ${app[k]} ≠ site ${site[k]}`);
    expect(drift).toEqual([]);
  });
});

// ── 8. A history event with no label renders as its own slug ───────────────────────────────
//
// CLAUDE.md §4. This has already happened once: `lease_adjusted` was written from 0082 with no
// entry, and the comment at HistoryPage.js:52 records that adding `balance_settled` beside it
// would have put a bare slug directly under a properly-labelled row.
describe('every history event type is in all three registries', () => {
  const written = uniq(
    APP.flatMap(({ src }) => [...src.matchAll(/logHistoryEvent\(\{[\s\S]{0,400}?type:\s*'([a-z_]+)'/g)].map((m) => m[1]))
  );
  const hist = read('src/pages/HistoryPage.js');
  const story = read('src/lib/tenantStory.js');

  it('found the real set (non-vacuity)', () => expect(written.length).toBeGreaterThan(12));

  // KNOWN, 2026-08-21 — in neither STORY_EVENTS nor LEDGER_EVENTS, so it takes the unknown-type
  // fallback into the ledger log. That fallback is QUIET rather than loud (tenantStory.js:50) and
  // in this case lands it in the right place anyway — an announcement goes to a property, not to
  // one tenancy. Listed because CLAUDE.md §4 says the entry should be explicit, not lucky.
  const KNOWN_STORY = ['announcement_sent'];

  it('has a label, a badge, and a home on the tenant story', () => {
    const label = hist.slice(hist.indexOf('EVENT_LABEL'), hist.indexOf('EVENT_BADGE'));
    const badge = hist.slice(hist.indexOf('EVENT_BADGE'));
    expect(written.filter((t) => !label.includes(`${t}:`))).toEqual([]);
    expect(written.filter((t) => !badge.includes(`${t}:`))).toEqual([]);
    expect(written.filter((t) => !story.includes(`'${t}'`) && !KNOWN_STORY.includes(t))).toEqual([]);
  });
});

// ── 9. Migration numbering ──────────────────────────────────────────────────────────────────
//
// Two sessions scaffolding at once is the normal way this collides, and a duplicate number means
// one of the two never runs on a fresh database.
describe('migrations are uniquely numbered', () => {
  const nums = readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 4));
  it('found them (non-vacuity)', () => expect(nums.length).toBeGreaterThan(50));
  it('has no collisions', () => {
    const dupes = nums.filter((n, i) => nums.indexOf(n) !== i);
    expect(uniq(dupes)).toEqual([]);
  });
});
