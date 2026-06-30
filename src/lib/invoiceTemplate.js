import { fmtDate } from './format';

// Builds one combined tenant invoice as plain text: a single amount due
// (base rent + CAM + tax, plus a separate Roof line when the tenant is roof-
// responsible) with an itemized breakdown showing each charge's monthly, annual,
// and per-square-foot (monthly + annual) cost. ALL arithmetic happens here in
// code — no AI, no rounding surprises.
//
// facts: {
//   business: { company_name, address, contact_email, contact_phone } | null,
//   tenant, tenant_contact_name, tenant_email,
//   property, property_address,
//   year,            // the invoice/billing year
//   tax_year,        // the prior year tax/CAM are based on (year - 1)
//   square_footage,
//   base_rent_annual, cam_annual, tax_annual, roof_annual,
//   today, due,      // ISO date strings (passed in so this stays pure/testable)
// }
const usd = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const LW = 22; // label column width
const CW = 13; // numeric column width

export function buildInvoice(facts) {
  const sf = Number(facts.square_footage) || 0;
  // Annual -> the four figures we display for every line.
  const per = (annual) => {
    const a = Number(annual) || 0;
    const m = a / 12;
    return { m, a, pm: sf ? m / sf : 0, py: sf ? a / sf : 0 };
  };

  const base = per(facts.base_rent_annual);
  const cam = per(facts.cam_annual);
  const tax = per(facts.tax_annual);
  const roof = Number(facts.roof_annual) > 0 ? per(facts.roof_annual) : null;

  const items = [
    { label: 'Base rent', v: base },
    { label: `CAM (${facts.year} est.)`, v: cam },
  ];
  if (roof) items.push({ label: `Roof (${facts.year})`, v: roof });
  items.push({ label: `Property tax (${facts.tax_year})`, v: tax });

  const totalAnnual = items.reduce((s, it) => s + it.v.a, 0);
  const total = per(totalAnnual);

  const cell = (s) => String(s).padStart(CW);
  const line = (label, v) => label.padEnd(LW) + cell(usd(v.m)) + cell(usd(v.a)) + cell(usd(v.pm)) + cell(usd(v.py));
  const divider = '-'.repeat(LW + CW * 4);

  const biz = facts.business || {};
  const invNo = `INV-${facts.year}-${(facts.tenant || 'TEN').replace(/\W+/g, '').slice(0, 4).toUpperCase()}`;
  const bizContact = [biz.contact_email, biz.contact_phone].filter(Boolean).join(' · ');

  const L = [];
  if (biz.company_name) L.push(biz.company_name);
  if (biz.address) L.push(biz.address);
  if (bizContact) L.push(bizContact);
  if (L.length) L.push('');

  L.push(`INVOICE  ·  ${invNo}`);
  L.push(`Invoice date: ${fmtDate(facts.today)}    Due: ${fmtDate(facts.due)} (Net 30)`);
  L.push('');
  L.push('BILL TO:');
  if (facts.tenant_contact_name) L.push(facts.tenant_contact_name);
  L.push(facts.tenant || 'Tenant');
  if (facts.property) L.push(`Premises: ${facts.property}${facts.property_address ? `, ${facts.property_address}` : ''}`);
  if (facts.tenant_email) L.push(facts.tenant_email);
  L.push('');

  L.push(`AMOUNT DUE:  ${usd(total.m)} per month   ·   ${usd(total.a)} per year`);
  L.push('');

  L.push(`ITEMIZED CHARGES — ${facts.year}`);
  L.push(''.padEnd(LW) + cell('Monthly') + cell('Annual') + cell('$/SF/mo') + cell('$/SF/yr'));
  L.push(divider);
  items.forEach((it) => L.push(line(it.label, it.v)));
  L.push(divider);
  L.push(line('TOTAL', total));
  L.push('');

  L.push('Notes');
  L.push(`• Property tax lags by a year — the ${facts.tax_year} assessed tax is billed on this ${facts.year} invoice (taxes are billed in arrears).`);
  L.push(`• CAM is an estimate based on ${facts.tax_year} actuals and is reconciled at year-end.`);
  L.push('');

  L.push(`Payment terms: Net 30. Please remit one combined payment of ${usd(total.m)} per month`);
  L.push(`to ${biz.company_name || 'our office'}${biz.contact_email ? `, or contact ${biz.contact_email}` : ''} with any questions. Thank you.`);

  return L.join('\n');
}
