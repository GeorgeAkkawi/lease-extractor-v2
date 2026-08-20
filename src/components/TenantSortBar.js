import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getLeaseSort, setLeaseSort } from '../lib/api';
import { TENANT_SORTS } from '../lib/leaseSort';
import SelectMenu from './SelectMenu';

// The sort control shared by the Rent Ledger and the per-tenant breakdown — one
// persisted preference (user_preferences.lease_sort.tenants) so both surfaces stay in
// step. Reuses the Leases-page `.lease-sortbar` styling and its optimistic-save shape.
// The parent reads the same ['leaseSort'] query and calls sortTenantRows(rows, tenant
// sort); this component only writes the choice.
export default function TenantSortBar() {
  const qc = useQueryClient();
  const { data: leaseSort = {} } = useQuery({ queryKey: ['leaseSort'], queryFn: getLeaseSort });
  const t = leaseSort.tenants || {};
  const mode = t.mode || 'tenant_name';
  const dir = t.dir || 'asc';

  // setLeaseSort merges top-level keys, so always write the WHOLE tenants object
  // (mode + dir) — a partial would drop the other field.
  const save = useMutation({
    mutationFn: (tenants) => setLeaseSort({ tenants }),
    onMutate: async (tenants) => {
      await qc.cancelQueries({ queryKey: ['leaseSort'] });
      const prev = qc.getQueryData(['leaseSort']);
      qc.setQueryData(['leaseSort'], (old = {}) => ({ ...(old || {}), tenants }));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['leaseSort'], ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['leaseSort'] }),
  });

  return (
    <div className="lease-sortbar">
      <label>
        <span className="muted">Sort by</span>
        <SelectMenu
          className="text-input"
          value={mode}
          onChange={(e) => save.mutate({ mode: e.target.value, dir })}
        >
          {TENANT_SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </SelectMenu>
      </label>
      <button
        type="button"
        className="secondary sort-dir"
        onClick={() => save.mutate({ mode, dir: dir === 'asc' ? 'desc' : 'asc' })}
        title={dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
      >
        {dir === 'asc' ? '↑ Asc' : '↓ Desc'}
      </button>
    </div>
  );
}
