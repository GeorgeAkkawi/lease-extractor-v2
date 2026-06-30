import { useQuery } from '@tanstack/react-query';
import { getTenantShares } from '../lib/api';
import { money, sf, pct } from '../lib/format';
import InvoiceButton from './InvoiceButton';

const psf2 = (n) => (n == null || isNaN(n) ? '—' : `$${Number(n).toFixed(2)}`);
const NBSP = ' ';

// A numeric cell with a main figure and an optional smaller sub-line. The sub
// element is always rendered (blank = NBSP) so every column shares the same
// height and the main figures line up across the row.
function NumCell({ main, sub, className = '' }) {
  return (
    <td className={`num ${className}`.trim()}>
      <div className="cell-main">{main}</div>
      <div className="cell-sub">{sub || NBSP}</div>
    </td>
  );
}

// Per-tenant breakdown: base rent + $/SF, share %, grouped Tax/CAM ($ and $/SF),
// roof column (billed only to roof-responsible tenants), and a totals row.
export default function TenantShareTable({ propertyId, year }) {
  const { data: shares = [], isLoading } = useQuery({
    queryKey: ['tenantShares', propertyId, year],
    queryFn: () => getTenantShares(propertyId, year),
  });

  if (isLoading) return <p className="muted">Loading…</p>;
  if (shares.length === 0) return <p className="muted">No tenants/leases for this property yet.</p>;

  const tot = shares.reduce(
    (a, s) => ({
      sf: a.sf + (Number(s.square_footage) || 0),
      tax: a.tax + (Number(s.tax_amount) || 0),
      cam: a.cam + (Number(s.cam_amount) || 0),
      roof: a.roof + (Number(s.roof_amt) || 0),
    }),
    { sf: 0, tax: 0, cam: 0, roof: 0 }
  );

  return (
    <div className="table-wrap">
      <table className="grouped">
        <thead>
          <tr>
            <th rowSpan={2}>Tenant</th>
            <th rowSpan={2} className="num">SF</th>
            <th rowSpan={2} className="num">Base rent</th>
            <th rowSpan={2} className="num">Share</th>
            <th colSpan={2} className="num grp">Property taxes</th>
            <th colSpan={2} className="num grp">CAM</th>
            <th rowSpan={2} className="num grp-start">Roof</th>
            <th rowSpan={2}></th>
          </tr>
          <tr>
            <th className="num grp-start sub">$</th>
            <th className="num sub">$/SF</th>
            <th className="num grp-start sub">$</th>
            <th className="num sub">$/SF</th>
          </tr>
        </thead>
        <tbody>
          {shares.map((s) => {
            const taxPsf = s.square_footage > 0 ? s.tax_amount / s.square_footage : null;
            const camPsf = s.square_footage > 0 ? s.cam_amount / s.square_footage : null;
            const roofPsf = s.square_footage > 0 ? s.roof_amt / s.square_footage : null;
            const roofBilled = s.roof_responsible && s.roof_amt > 0;
            return (
              <tr key={s.lease_id}>
                <td>{s.tenant_name}</td>
                <NumCell main={sf(s.square_footage)} />
                <NumCell main={money(s.base_rent)} sub={s.square_footage > 0 ? psf2(s.base_rent / s.square_footage) + '/SF' : ''} />
                <NumCell main={pct(s.share_pct)} />
                <NumCell className="grp-start" main={money(s.tax_amount)} />
                <NumCell main={psf2(taxPsf)} />
                <NumCell className="grp-start" main={money(s.cam_amount)} />
                <NumCell main={psf2(camPsf)} />
                <NumCell className="grp-start" main={roofBilled ? money(s.roof_amt) : <span className="muted">—</span>} sub={roofBilled ? psf2(roofPsf) + '/SF' : ''} />
                <td className="num"><InvoiceButton share={s} /></td>
              </tr>
            );
          })}
          <tr className="total-row">
            <td>Totals</td>
            <td className="num">{sf(tot.sf)}</td>
            <td className="num"></td>
            <td className="num"></td>
            <td className="num grp-start">{money(tot.tax)}</td>
            <td className="num"></td>
            <td className="num grp-start">{money(tot.cam)}</td>
            <td className="num"></td>
            <td className="num grp-start">{money(tot.roof)}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <div className="table-note muted">
        Tax &amp; CAM allocated pro-rata by square footage (or a per-lease override). Roof is billed by PSF
        only to roof-responsible tenants; the rest is absorbed by the landlord and it stays out of the tax/CAM PSF pool.
      </div>
    </div>
  );
}
