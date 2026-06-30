import { currentYear } from '../lib/format';

export default function YearSelector({ year, setYear, span = 6 }) {
  const now = currentYear();
  const years = [];
  for (let y = now + 1; y >= now - span; y--) years.push(y);
  return (
    <div className="field" style={{ maxWidth: 160, marginBottom: 0 }}>
      <label>Year</label>
      <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </div>
  );
}
