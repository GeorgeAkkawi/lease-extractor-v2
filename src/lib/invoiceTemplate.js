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
  const W = divider.length; // full invoice width, matches the table

  const L = [];

  // Letterhead: sending corporation, then a full-width rule.
  if (biz.company_name) L.push(biz.company_name);
  if (biz.address) L.push(biz.address);
  if (bizContact) L.push(bizContact);
  if (L.length) L.push(divider);

  // Invoice number right-aligned beside the heading, then dates on aligned lines.
  L.push('INVOICE'.padEnd(Math.max(8, W - invNo.length)) + invNo);
  L.push('Invoice date:'.padEnd(15) + fmtDate(facts.today));
  L.push('Payment due:'.padEnd(15) + fmtDate(facts.due) + '  (Net 30)');
  L.push('');

  L.push('BILL TO');
  L.push([facts.tenant_contact_name, facts.tenant].filter(Boolean).join(' — ') || 'Tenant');
  if (facts.tenant_email) L.push(facts.tenant_email);
  if (facts.property) {
    const premises = `${facts.property}${facts.property_address ? `, ${facts.property_address}` : ''}`;
    L.push(`Premises: ${premises}${sf ? ` (${sf.toLocaleString('en-US')} SF)` : ''}`);
  }
  L.push(divider);

  // Itemized charges — kept at full detail (monthly / annual / $ per SF).
  L.push('CHARGE'.padEnd(LW) + cell('MONTHLY') + cell('ANNUAL') + cell('$/SF/MO') + cell('$/SF/YR'));
  L.push(divider);
  items.forEach((it) => L.push(line(it.label, it.v)));
  L.push(divider);
  L.push(line('AMOUNT DUE', total));
  L.push(divider);
  L.push('');

  // Remittance.
  const remitTo = biz.company_name || 'our office';
  const stop = /[.!?]$/.test(remitTo) ? '' : '.'; // avoid "Inc.." when the name already ends in a period
  const ask = biz.contact_email ? ` Questions? ${biz.contact_email}.` : '';
  L.push(`Please remit ${usd(total.m)}/month to ${remitTo}${stop}${ask} Thank you.`);

  return L.join('\n');
}
