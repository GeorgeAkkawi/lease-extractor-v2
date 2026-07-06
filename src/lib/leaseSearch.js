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
