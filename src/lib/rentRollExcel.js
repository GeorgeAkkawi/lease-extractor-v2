// Styled rent-roll workbook builder. Takes the data the dashboard already has
// (leases + properties from fetchSearchIndex) and lays it out as a polished,
// lender/accountant-ready Excel file — one worksheet per property, each with a
// summary block + a commercial rent-roll table. No AI, no network: pure
// formatting that runs in the browser. ExcelJS is loaded lazily by the caller.

// ---- column geometry (A..N) -------------------------------------------------
// Suite | Tenant | Size(SF,%NRSF) | Annual Rent(Annual,PSF,%Total) |
// Lease Terms(Type,Commence,Expiration,Term,InTerm) | Notes | Category
const COLS = [
  { key: 'suite', width: 9 },
  { key: 'tenant', width: 26 },
  { key: 'sf', width: 11, fmt: '#,##0' },
  { key: 'pctNrsf', width: 10, fmt: '0.0%' },
  { key: 'annual', width: 15, fmt: '$#,##0.00' },
  { key: 'psf', width: 13, fmt: '$#,##0.00' },
  { key: 'pctTotal', width: 9, fmt: '0.0%' },
  { key: 'type', width: 13 },
  { key: 'commence', width: 13, fmt: 'mm/dd/yyyy' },
  { key: 'expiration', width: 13, fmt: 'mm/dd/yyyy' },
  { key: 'term', width: 8, fmt: '0' },
  { key: 'inTerm', width: 9 },
  { key: 'notes', width: 30 },
  { key: 'category', width: 14 },
];
const LAST_COL = 'N'; // 14th column
const NAVY = 'FF1F3A5F';
const GROUP_FILL = 'FFD9E1EC';
const SUB_FILL = 'FFEEF2F7';

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFBFC8D6' } };
const allBorders = { top: thin, left: thin, bottom: thin, right: thin };

// Parse yyyy-mm-dd at local noon so day-only strings don't drift across
// timezones (same convention as fmtDate / leaseTerm.noon).
function toDate(d) {
  if (!d) return null;
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  const t = new Date(s);
  return isNaN(t) ? null : t;
}
function isInTerm(start, end, now) {
  const s = toDate(start), e = toDate(end);
  if (s && now < s) return false;
  if (e && now >= e) return false;
  return s || e ? 'Yes' : '';
}
// Lease term in whole months, rounded from the day-span. Robust to either
// expiration convention (last-of-month "8/31" or anniversary "9/1") — both a
// 5-year and a 3-year lease round to 60 and 36 as a reader expects.
function termMonths(start, end) {
  const s = toDate(start), e = toDate(end);
  if (!s || !e || e < s) return null;
  return Math.round((e - s) / 86400000 / (365.25 / 12));
}
// Excel tab names: ≤31 chars, none of : \ / ? * [ ]. Dedupe collisions.
function safeSheetName(name, used) {
  let base = (name || 'Property').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Property';
  let n = base, i = 2;
  while (used.has(n)) { const suffix = ` (${i++})`; n = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(n);
  return n;
}

// Build one property's worksheet.
function addPropertySheet(wb, usedNames, property, leases, now) {
  // Freeze the title + summary + column headers (rows 1-9) so they stay visible
  // while the tenant rows scroll. A real split is required — a frozen pane with
  // no split row makes Excel flag the file as corrupt ("recover content").
  const ws = wb.addWorksheet(safeSheetName(property.name, usedNames), {
    views: [{ state: 'frozen', ySplit: 9, topLeftCell: 'A10' }],
  });
  COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

  const buildingSf = Number(property.building_sf) || 0;
  const leasedSf = leases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const annualRent = leases.reduce((s, l) => s + (Number(l.base_rent) || 0), 0);
  const occ = buildingSf > 0 ? leasedSf / buildingSf : null;
  const wtdPsf = leasedSf > 0 ? annualRent / leasedSf : null;

  // --- Title band ---
  ws.mergeCells(`A1:${LAST_COL}1`);
  const title = ws.getCell('A1');
  title.value = 'Commercial Rent Roll';
  title.font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  title.fill = fill(NAVY);
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 26;

  ws.mergeCells(`A2:${LAST_COL}2`);
  const sub = ws.getCell('A2');
  sub.value = property.name || '—';
  sub.font = { bold: true, size: 12, color: { argb: NAVY } };
  sub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(2).height = 20;

  // --- Summary block (two label/value pairs per row) ---
  // "as of" at local noon so the mm/dd/yyyy cell always renders today (a raw
  // timestamp can roll to the next day once Excel applies the timezone offset).
  const asOf = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const pairLabel = (cell, text) => {
    const c = ws.getCell(cell);
    c.value = text;
    c.font = { bold: true, size: 10, color: { argb: 'FF5A6B82' } };
    c.alignment = { horizontal: 'left' };
  };
  const pairVal = (cell, value, fmt) => {
    const c = ws.getCell(cell);
    c.value = value;
    if (fmt) c.numFmt = fmt;
    c.font = { bold: true, size: 10 };
  };
  // Left column of stats (labels A:B merged, value C) / right column (labels E:F, value G)
  const rows = [
    ['Number of Tenants:', leases.length, null, 'Current Occ %:', occ, '0.0%'],
    ['Total Rentable SF:', buildingSf || null, '#,##0', 'Annual Rent Revenue:', annualRent, '$#,##0.00'],
    ['Rent Roll as of:', asOf, 'mm/dd/yyyy', 'Wtd Avg Rent /SF:', wtdPsf, '$#,##0.00'],
  ];
  rows.forEach((row, i) => {
    const r = 4 + i;
    ws.mergeCells(`A${r}:B${r}`);
    pairLabel(`A${r}`, row[0]);
    pairVal(`C${r}`, row[1], row[2]);
    ws.mergeCells(`E${r}:F${r}`);
    pairLabel(`E${r}`, row[3]);
    pairVal(`G${r}`, row[4], row[5]);
  });

  // --- Grouped column header (two rows) ---
  const g = 8; // group-header row
  const h = 9; // sub-header row
  const groupCell = (range, text) => {
    ws.mergeCells(range);
    const c = ws.getCell(range.split(':')[0]);
    c.value = text;
    c.font = { bold: true, size: 10, color: { argb: NAVY } };
    c.fill = fill(GROUP_FILL);
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  };
  // single-column heads span both header rows; group heads span their columns
  groupCell(`A${g}:A${h}`, 'Suite');
  groupCell(`B${g}:B${h}`, 'Tenant');
  groupCell(`C${g}:D${g}`, 'Size');
  groupCell(`E${g}:G${g}`, 'Annual Rent');
  groupCell(`H${g}:L${g}`, 'Lease Terms');
  groupCell(`M${g}:M${h}`, 'Notes');
  groupCell(`N${g}:N${h}`, 'Category');
  const subHead = (col, text) => {
    const c = ws.getCell(`${col}${h}`);
    c.value = text;
    c.font = { italic: true, size: 9, color: { argb: NAVY } };
    c.fill = fill(SUB_FILL);
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  };
  subHead('C', 'SF'); subHead('D', '% of NRSF');
  subHead('E', 'Annual'); subHead('F', 'Base Rent PSF'); subHead('G', '% of Total');
  subHead('H', 'Type'); subHead('I', 'Commence'); subHead('J', 'Expiration');
  subHead('K', 'Term (mos)'); subHead('L', 'In Term?');
  // border the whole header block
  for (let r = g; r <= h; r++) {
    for (let c = 1; c <= COLS.length; c++) ws.getCell(r, c).border = allBorders;
  }

  // --- Tenant rows ---
  const sorted = [...leases].sort((a, b) => (a.tenant_name || '').localeCompare(b.tenant_name || ''));
  let r = h + 1;
  for (const l of sorted) {
    const rowIdx = r;
    const sf = Number(l.square_footage) || 0;
    const rent = Number(l.base_rent) || 0;
    const values = [
      '', // Suite — not tracked yet
      l.tenant_name || '',
      sf || null,
      buildingSf > 0 ? sf / buildingSf : null,
      rent || null,
      sf > 0 ? rent / sf : null,
      annualRent > 0 ? rent / annualRent : null,
      '', // Lease Type — not tracked yet
      toDate(l.lease_start),
      toDate(l.lease_termination_date),
      termMonths(l.lease_start, l.lease_termination_date),
      isInTerm(l.lease_start, l.lease_termination_date, now),
      l.lease_terms || '',
      '', // Tenant Category — not tracked yet
    ];
    values.forEach((v, i) => {
      const cell = ws.getCell(rowIdx, i + 1);
      cell.value = v;
      if (COLS[i].fmt && v != null && v !== '') cell.numFmt = COLS[i].fmt;
      cell.border = allBorders;
      cell.font = { size: 10 };
      if (['sf', 'pctNrsf', 'annual', 'psf', 'pctTotal', 'term'].includes(COLS[i].key))
        cell.alignment = { horizontal: 'right' };
      if (['commence', 'expiration', 'inTerm'].includes(COLS[i].key))
        cell.alignment = { horizontal: 'center' };
    });
    r++;
  }

  // --- Totals row ---
  const totalDef = {
    B: 'Total / Weighted', C: leasedSf || null, D: occ,
    E: annualRent || null, F: wtdPsf, G: annualRent > 0 ? 1 : null,
  };
  Object.entries(totalDef).forEach(([col, v]) => {
    const cell = ws.getCell(`${col}${r}`);
    cell.value = v;
    const colDef = COLS[col.charCodeAt(0) - 65];
    if (colDef?.fmt && v != null) cell.numFmt = colDef.fmt;
    cell.font = { bold: true, size: 10 };
    cell.fill = fill(GROUP_FILL);
    if (['C', 'D', 'E', 'F', 'G'].includes(col)) cell.alignment = { horizontal: 'right' };
  });
  for (let c = 1; c <= COLS.length; c++) {
    const cell = ws.getCell(r, c);
    cell.border = allBorders;
    if (!cell.fill) cell.fill = fill(GROUP_FILL);
    if (!cell.font) cell.font = { bold: true };
  }
}

/**
 * Build and download a styled rent-roll .xlsx. Reuses the leases + properties
 * already loaded for the dashboard (no extra fetch). ExcelJS is imported lazily
 * (browser bundle) so it stays out of the initial page load.
 *
 * Pass `fileLabel` (e.g. a single building's name) to tag the filename — a
 * one-property export then downloads as `rent-roll-River-Landing-2026-06-30.xlsx`
 * instead of the generic portfolio name.
 */
export async function downloadRentRollXlsx({ leases = [], properties = [], fileLabel } = {}) {
  const mod = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const now = new Date();

  const active = leases.filter((l) => l.is_active !== false);
  const propById = Object.fromEntries(properties.map((p) => [p.id, p]));
  // group active leases by property, preserving an "Unassigned" bucket for orphans
  const byProp = new Map();
  for (const l of active) {
    const key = l.property_id || '__none__';
    if (!byProp.has(key)) byProp.set(key, []);
    byProp.get(key).push(l);
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amlak';
  const usedNames = new Set();
  // one sheet per property that has at least one active lease, in name order
  const ordered = [...byProp.keys()].sort((a, b) =>
    (propById[a]?.name || '￿').localeCompare(propById[b]?.name || '￿'));
  for (const key of ordered) {
    const property = propById[key] || { id: key, name: '(No property)', building_sf: null };
    addPropertySheet(wb, usedNames, property, byProp.get(key), now);
  }
  if (!wb.worksheets.length) addPropertySheet(wb, usedNames, { name: 'Rent Roll', building_sf: null }, [], now);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const slugged = fileLabel
    ? String(fileLabel).trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')
    : '';
  const a = document.createElement('a');
  a.href = url;
  a.download = `rent-roll${slugged ? `-${slugged}` : ''}-${now.toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
