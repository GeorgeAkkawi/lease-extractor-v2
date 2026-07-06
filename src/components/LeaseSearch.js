import { useQuery } from '@tanstack/react-query';
import { listAddendumsByLeases } from '../lib/api';
import { searchLeases } from '../lib/leaseSearch';
import { fmtDate } from '../lib/format';

// Search every cached lease document at this property — a pure in-browser scan
// of the text cached at import (originals + riders). No AI call, no cost: it
// matches words and shows the surrounding clause so the landlord judges it.
export default function LeaseSearch({ propId, query, onChange, leases = [], onOpen, onWarm }) {
  const active = query.trim().length > 0;

  // Rider texts load once per property, and only when a search actually starts,
  // so the page load stays as light as before.
  const { data: addendumsByLease = {} } = useQuery({
    queryKey: ['addendumsByLeases', propId],
    queryFn: () => listAddendumsByLeases(leases.map((l) => l.id)),
    enabled: active && leases.length > 0,
  });

  const { matches, unsearchable } = searchLeases(query, leases, addendumsByLease);

  return (
    <div className="lease-search">
      <input
        className="text-input lease-search-input"
        type="search"
        placeholder="Search all leases here — try roof, parking, insurance…"
        aria-label="Search leases"
        value={query}
        onChange={(e) => onChange(e.target.value)}
      />
      {active && (
        <div className="lease-list search-results">
          {matches.map((m) => (
            <button
              key={m.lease.id}
              className="lease-row search-hit"
              onClick={() => onOpen(m.lease.id)}
              onMouseEnter={onWarm ? () => onWarm(m.lease.id) : undefined}
              onFocus={onWarm ? () => onWarm(m.lease.id) : undefined}
            >
              <span className="lease-name">
                <strong>{m.lease.tenant_name}</strong>
                <span className="muted">
                  {m.count} match{m.count === 1 ? '' : 'es'} · term ends{' '}
                  {m.lease.lease_termination_date ? fmtDate(m.lease.lease_termination_date) : '—'}
                </span>
              </span>
              <span className="hit-snippets">
                {m.snippets.map((s, i) => (
                  <span key={i} className="hit-snippet">
                    …{s.before}<mark>{s.hit}</mark>{s.after}…
                    {s.source ? <em> — {s.source}</em> : null}
                  </span>
                ))}
              </span>
              <span className="chevron">›</span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="muted">No lease at this property mentions “{query.trim()}”.</p>
          )}
          {unsearchable.length > 0 && (
            <p className="muted search-note">
              {unsearchable.length === 1 ? '1 lease has' : `${unsearchable.length} leases have`} no
              document on file and can't be searched: {unsearchable.map((l) => l.tenant_name).join(', ')}.
              Open the lease and upload or paste its document to make it searchable.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
