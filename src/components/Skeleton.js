// Lightweight loading placeholders. Used for the rare genuinely-cold load (very
// first app open, hard refresh, keyboard nav with no hover). They reuse the page's
// own grid/list classes and card-sized heights so the placeholder occupies the
// same space as the real content — no layout shift, no jarring text→content swap.

export default function Skeleton({ w = '100%', h = 12, r = 'var(--radius)', style, className = '' }) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ display: 'block', width: w, height: h, borderRadius: r, ...style }}
      aria-hidden="true"
    />
  );
}

// A grid of card-shaped placeholders (corp grid, property grid).
export function CardGridSkeleton({ className = 'corp-grid', count = 4, height = 96 }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} h={height} />
      ))}
    </div>
  );
}

// A stacked list of row-shaped placeholders (lease list).
export function RowListSkeleton({ className = 'lease-list', count = 4, height = 66 }) {
  return (
    <div className={className} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} h={height} />
      ))}
    </div>
  );
}

// A page-level placeholder for detail pages: a title bar + a couple of panels.
export function PageSkeleton() {
  return (
    <div aria-hidden="true">
      <div style={{ marginBottom: 28, paddingBottom: 22, borderBottom: '1px solid var(--line)' }}>
        <Skeleton w="42%" h={40} />
        <Skeleton w="26%" h={14} style={{ marginTop: 12 }} />
      </div>
      <Skeleton h={150} style={{ marginBottom: 20 }} />
      <Skeleton h={120} />
    </div>
  );
}
