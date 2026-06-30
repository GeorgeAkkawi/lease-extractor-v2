import { useChrome } from '../context/ChromeContext';
import Breadcrumb from './Breadcrumb';
import { currentYear } from '../lib/format';

export default function TopBar() {
  const { crumbs, year, setYear, yearVisible } = useChrome();
  const now = currentYear();
  const years = [];
  for (let y = now + 1; y >= now - 4; y--) years.push(y);

  return (
    <header className="topbar">
      <Breadcrumb crumbs={crumbs} />
      <div className="topbar-right">
        {yearVisible && (
          <div className="year-sel">
            <span>FY</span>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        )}
      </div>
    </header>
  );
}
