// Free, in-browser search across a property's cached lease documents — no AI,
// no network. It scans the plain-text copies already cached at import time
// (leases.lease_text, lease_addendums.addendum_text). Matching is by words,
// not meaning: the UI shows the surrounding clause so the landlord makes the
// judgment call ("Tenant shall repair the roof" vs "Landlord shall…").

const CONTEXT = 60; // chars of context kept on each side of a hit
const MAX_SNIPPETS = 3; // shown per lease
const MAX_HITS = 200; // stop counting occurrences past this (bounds the scan)

// Soonest term end first; leases with no end date sort last; ties alphabetical
// by tenant. Used everywhere a property's tenants are listed.
export function byTermEnd(a, b) {
  const da = a?.lease_termination_date;
  const db = b?.lease_termination_date;
  if (da && db && da !== db) return String(da).localeCompare(String(db));
  if (!da && db) return 1;
  if (da && !db) return -1;
  return String(a?.tenant_name || '').localeCompare(String(b?.tenant_name || ''));
}

const squash = (s) => String(s).replace(/\s+/g, ' ');

// query: free text. leases: the property's rows (lease_text rides along from
// listLeases's select('*')). addendumsByLease: { leaseId: rider rows } so a
// rider that changed a term is searched too. A lease matches when EVERY word
// of the query appears in its tenant name, lease text, or any rider text.
// Returns { matches: [{ lease, snippets, count }], unsearchable } — a snippet
// is { before, hit, after, source } (source = rider label, null = the lease
// itself) so the UI can highlight without raw HTML; unsearchable = leases with
// no cached document text at all (entered by hand).
export function searchLeases(query, leases = [], addendumsByLease = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = [];
  const unsearchable = [];

  for (const lease of leases) {
    const docSources = [];
    if (String(lease.lease_text || '').trim()) docSources.push({ label: null, text: lease.lease_text });
    for (const a of addendumsByLease[lease.id] || []) {
      if (String(a.addendum_text || '').trim()) docSources.push({ label: a.label || 'Amendment', text: a.addendum_text });
    }
    if (docSources.length === 0) {
      unsearchable.push(lease);
      continue;
    }
    if (words.length === 0) continue;

    const sources = [{ label: 'tenant name', text: String(lease.tenant_name || '') }, ...docSources]
      .map((s) => ({ ...s, lower: s.text.toLowerCase() }));
    if (!words.every((w) => sources.some((s) => s.lower.includes(w)))) continue;

    let count = 0;
    const snippets = [];
    for (const s of sources) {
      for (const w of words) {
        for (let i = s.lower.indexOf(w); i !== -1 && count < MAX_HITS; i = s.lower.indexOf(w, i + w.length)) {
          count += 1;
          const overlaps = snippets.some((p) => p.ref === s && Math.abs(p.at - i) < CONTEXT);
          if (snippets.length < MAX_SNIPPETS && !overlaps) {
            snippets.push({
              ref: s,
              at: i,
              source: s.label,
              before: squash(s.text.slice(Math.max(0, i - CONTEXT), i)),
              hit: s.text.slice(i, i + w.length),
              after: squash(s.text.slice(i + w.length, i + w.length + CONTEXT)),
            });
          }
        }
      }
    }
    matches.push({ lease, count, snippets: snippets.map(({ ref, at, ...keep }) => keep) });
  }

  return { matches, unsearchable };
}

// ---- Cheap AI-answer helpers -------------------------------------------------
// Used only when the landlord asks the AI to answer a question ACROSS the property's
// leases (e.g. "who's responsible for the roof?"). The free keyword search above needs
// none of this. These shape the *cheapest* possible AI input — only the clauses the
// keyword search already matched — plus a fingerprint so an unchanged corpus reuses a
// cached answer for free. All pure: no network, no AI.

const SMALL_CORPUS_CHARS = 120000; // ≲ ~30k tokens → cheap enough to send whole leases
const CLAUSE_RADIUS = 400; // chars kept each side of a hit before trimming to a boundary
const MAX_CLAUSE = 900; // a single widened clause never exceeds this
const MAX_CHARS_PER_LEASE = 2400; // total evidence sent per lease in clause mode
const MAX_FULL_PER_LEASE = 40000; // safety cap on a single lease in full mode

const textLen = (s) => String(s || '').length;

// Lowercase / trim / collapse whitespace so "Who pays the roof?" and "who pays  roof"
// map to the same cache key.
export function normalizeQuestion(q) {
  return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Turn a search term into the question the AI answers over the matched clauses.
// (The keyword search requires every word to appear in the lease, so we can't send
// George's raw English question as the filter — we filter by his TERM and template
// the question around it.)
export function buildLeaseQuestion(term) {
  const t = String(term || '').trim();
  return (
    `The landlord searched their leases for "${t}". For each tenant below, say whether ` +
    `the TENANT or the LANDLORD is responsible for ${t} (or the related obligation / ` +
    `expense), and quote the exact clause that shows it. If a tenant's material doesn't ` +
    `address "${t}", say so plainly for that tenant. Group the answer by tenant, one ` +
    `short line each. Answer only from the material; do not guess.`
  );
}

// A cheap content fingerprint for a property's cached lease corpus. Any lease/rider
// added, edited, or removed changes a text length or updated_at, so the fingerprint
// flips and that property's cached AI answers fall out of use — no stale answers.
export function leaseCorpusFingerprint(leases = [], addendumsByLease = {}) {
  const parts = [];
  for (const l of [...leases].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const riders = (addendumsByLease[l.id] || [])
      .map((r) => `${r.id}:${textLen(r.addendum_text)}:${r.updated_at || ''}`)
      .join(',');
    parts.push(`${l.id}:${textLen(l.lease_text)}:${l.updated_at || l.created_at || ''}:${riders}`);
  }
  return `v1|${parts.join('|')}`;
}

// Expand a hit to its surrounding clause: walk out to the nearest sentence break /
// newline within a radius so the AI sees "Tenant shall repair the roof at its sole
// cost", not a mid-word fragment.
function clauseAround(text, at, hitLen) {
  let start = Math.max(0, at - CLAUSE_RADIUS);
  const end0 = Math.min(text.length, at + hitLen + CLAUSE_RADIUS);
  const head = text.slice(start, at);
  const b = Math.max(head.lastIndexOf('. '), head.lastIndexOf('\n'));
  if (b !== -1) start += b + 1;
  let end = end0;
  const tail = text.slice(at + hitLen, end0);
  const e = tail.search(/[.\n]/);
  if (e !== -1) end = at + hitLen + e + 1;
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, MAX_CLAUSE);
}

// Build the AI's evidence: for each lease that matches the term, the widened clauses
// around each hit (deduped, capped), labeled by tenant. On a small property corpus,
// send each matched lease's full text instead (perfect coverage, still cheap).
// Returns [{ tenant, text }] — only leases that actually match are included.
export function gatherAnswerContext(query, leases = [], addendumsByLease = {}, opts = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const smallCorpus = opts.smallCorpusChars ?? SMALL_CORPUS_CHARS;
  const totalChars = leases.reduce((n, l) => {
    const riders = addendumsByLease[l.id] || [];
    return n + textLen(l.lease_text) + riders.reduce((m, r) => m + textLen(r.addendum_text), 0);
  }, 0);
  const fullMode = totalChars > 0 && totalChars <= smallCorpus;

  const out = [];
  for (const lease of leases) {
    const docs = [];
    if (String(lease.lease_text || '').trim()) docs.push({ label: null, text: lease.lease_text });
    for (const a of addendumsByLease[lease.id] || []) {
      if (String(a.addendum_text || '').trim()) docs.push({ label: a.label || 'Amendment', text: a.addendum_text });
    }
    if (docs.length === 0) continue; // nothing on file to reason over

    const hay = [String(lease.tenant_name || ''), ...docs.map((d) => d.text)].join('\n').toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue; // not a match

    let text;
    if (fullMode) {
      text = docs
        .map((d) => (d.label ? `[${d.label}]\n` : '') + d.text)
        .join('\n\n')
        .slice(0, MAX_FULL_PER_LEASE);
    } else {
      const clauses = [];
      let used = 0;
      let capped = false;
      for (const d of docs) {
        if (capped) break;
        const lower = d.text.toLowerCase();
        for (const w of words) {
          for (let i = lower.indexOf(w); i !== -1; i = lower.indexOf(w, i + w.length)) {
            const c = clauseAround(d.text, i, w.length);
            if (!c || clauses.some((x) => x.text === c)) continue;
            const labeled = d.label ? `[${d.label}] ${c}` : c;
            if (used + labeled.length > MAX_CHARS_PER_LEASE) { capped = true; break; }
            clauses.push({ text: c, labeled });
            used += labeled.length;
          }
          if (capped) break;
        }
      }
      if (clauses.length === 0) continue;
      text = clauses.map((x) => x.labeled).join(' … ');
    }
    out.push({ tenant: lease.tenant_name || 'Tenant', text });
  }
  return out;
}
