import { Link } from 'react-router-dom';

// Renders the breadcrumb trail in the top bar. crumbs = [{ label, to? }].
export default function Breadcrumb({ crumbs }) {
  if (!crumbs || crumbs.length === 0) return <div className="crumbs" />;
  return (
    <div className="crumbs">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span className="crumb" key={i}>
            {last || !c.to ? (
              <span className="crumb-cur">{c.label}</span>
            ) : (
              <Link className="crumb-link" to={c.to}>{c.label}</Link>
            )}
            {!last && <span className="crumb-sep">›</span>}
          </span>
        );
      })}
    </div>
  );
}
