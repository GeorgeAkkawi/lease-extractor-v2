import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listImportRules, listLeases, listCamLineItems, saveImportRule, deleteImportRule } from '../lib/api';
import { CAM_KEYWORD_LABELS } from '../lib/statementMatch';
import { resolvePick } from './StatementReview';
import MutationError from './MutationError';

// The learned-payee memory, editable. Every checked tenant deposit teaches a
// "always match {payee} → {tenant}" rule (StatementReview save), and an expense line
// does the same when its "Always" box is ticked — so the NEXT statement auto-classifies
// that payee. This panel is where the landlord audits and corrects that memory:
// retarget a rule that learned the wrong tenant/bucket, or drop one that's misfiring.
// Mirrors the imported-statements register's idiom exactly (count-gated disclosure +
// plain table) so it needs no new CSS. Hidden until this property has learned a rule.
//
// A retarget re-saves the SAME (property, pattern) key, which hits saveImportRule's
// 23505 update path and PRESERVES the rule id — so an import's applied[].rule_id stays
// valid and its ↩ Undo still works. Note the flip side: undoing an import whose rule
// carried a `prior` re-creates/overwrites the rule you edited here (undo restores the
// pre-import world).
export default function LearnedPayeesPanel({ propId, year }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: allRules = [] } = useQuery({ queryKey: ['importRules'], queryFn: listImportRules });
  const { data: leases = [] } = useQuery({ queryKey: ['leases', propId], queryFn: () => listLeases(propId) });
  const { data: camItems = [] } = useQuery({ queryKey: ['camLineItems', propId, year], queryFn: () => listCamLineItems(propId, year) });

  // Rules recorded on THIS property (a tenant rule's property is the tenant's own
  // property; an expense rule's is where the expense posts).
  const rules = useMemo(
    () => allRules.filter((r) => r.property_id === propId).sort((a, b) => String(a.pattern).localeCompare(String(b.pattern))),
    [allRules, propId]
  );
  const tenantName = useMemo(() => Object.fromEntries(leases.map((l) => [l.id, l.tenant_name])), [leases]);

  // The CAM/other buckets the retarget dropdown offers: the property's itemized labels
  // + the keyword built-ins + any label the rules themselves carry (so a rule's own
  // bucket always appears). First writer wins per name.
  const buckets = useMemo(() => {
    const map = new Map();
    const add = (label, billable) => {
      const clean = String(label || '').trim();
      if (clean && !map.has(clean.toLowerCase())) map.set(clean.toLowerCase(), { label: clean, billable });
    };
    for (const c of camItems) add(c.label, c.billable !== false);
    for (const l of CAM_KEYWORD_LABELS) add(l, true);
    for (const r of rules) if (r.cam_label) add(r.cam_label, r.target_kind !== 'expense_other');
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [camItems, rules]);

  const retarget = useMutation({
    mutationFn: ({ rule, pick }) => {
      const t = resolvePick(pick);
      if (!t) throw new Error('Pick a target for this payee.');
      return saveImportRule({
        property_id: rule.property_id,
        pattern: rule.pattern,
        target_kind: t.kind,
        lease_id: t.lease_id || null,
        cam_label: t.label || null,
        account_hint: rule.account_hint || null,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importRules'] });
      qc.invalidateQueries({ queryKey: ['statementContext'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id) => deleteImportRule(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importRules'] });
      qc.invalidateQueries({ queryKey: ['statementContext'] });
    },
  });

  if (!rules.length) return null;

  return (
    <div style={{ marginTop: 14 }}>
      <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Learned payees ({rules.length}) — {open ? 'hide' : 'show'}
      </button>
      {open && (
        <>
          <MutationError of={[retarget, remove]} />
          <table style={{ minWidth: 0, marginTop: 8 }}>
            <thead><tr><th>Payee</th><th>Records as</th><th>Account</th><th></th></tr></thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td><code>{rule.pattern}</code></td>
                  <td>
                    <RuleTargetSelect
                      rule={rule}
                      leases={leases}
                      buckets={buckets}
                      tenantName={tenantName}
                      disabled={retarget.isPending}
                      onChange={(pick) => retarget.mutate({ rule, pick })}
                    />
                  </td>
                  <td>{rule.account_hint || '—'}</td>
                  <td className="num">
                    <button type="button" className="ghost btn-sm" disabled={remove.isPending}
                      onClick={() => { if (window.confirm(`Stop auto-matching "${rule.pattern}"? Future statements won't recognize this payee (past imports are untouched).`)) remove.mutate(rule.id); }}>
                      ✕ Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            A learned payee auto-classifies the same deposit or expense on every future statement — for this account and any other, so a tenant who switched banks is still recognized.
          </div>
        </>
      )}
    </div>
  );
}

// The retarget dropdown for one rule. Family-constrained to keep the (property, pattern)
// key stable: a tenant rule offers this property's tenants + Ignore; an expense/ignore
// rule offers the expense families + Ignore. Same pick vocabulary as the review row, so
// resolvePick decodes the choice identically.
function RuleTargetSelect({ rule, leases, buckets, tenantName, disabled, onChange }) {
  const value = ruleToPick(rule, tenantName);
  const isTenant = rule.target_kind === 'tenant';
  const billable = buckets.filter((b) => b.billable);
  const other = buckets.filter((b) => !b.billable);
  return (
    <select className="text-input" style={{ maxWidth: 230 }} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {isTenant ? (
        <>
          <optgroup label="Tenant">
            {leases.map((l) => <option key={l.id} value={`lease:${l.id}`}>{l.tenant_name}</option>)}
            {!leases.some((l) => l.id === rule.lease_id) && rule.lease_id && (
              <option value={`lease:${rule.lease_id}`}>{tenantName[rule.lease_id] || 'removed tenant'}</option>
            )}
          </optgroup>
          <option value="ignore">Ignore</option>
        </>
      ) : (
        <>
          <option value="expense_tax">Property taxes</option>
          <option value="expense_roof">Roof expense</option>
          <optgroup label="CAM buckets — billed to tenants">
            {billable.map((b) => <option key={b.label} value={`cam:${b.label}`}>{b.label}</option>)}
            <option value="expense_cam">CAM — general</option>
          </optgroup>
          <optgroup label="Not billed to tenants">
            {other.map((b) => <option key={b.label} value={`other:${b.label}`}>{b.label}</option>)}
            {!other.some((b) => b.label.toLowerCase() === 'other') && <option value="other:Other">Other — not billed</option>}
          </optgroup>
          <option value="ignore">Ignore</option>
        </>
      )}
    </select>
  );
}

// A saved rule → its current pick value (the inverse of resolvePick, for the <select>).
function ruleToPick(rule) {
  switch (rule.target_kind) {
    case 'tenant': return rule.lease_id ? `lease:${rule.lease_id}` : '';
    case 'expense_cam': return rule.cam_label ? `cam:${rule.cam_label}` : 'expense_cam';
    case 'expense_other': return rule.cam_label ? `other:${rule.cam_label}` : 'other:Other';
    default: return rule.target_kind; // expense_tax | expense_roof | ignore
  }
}
