import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { listCorporations, createCorporation, listCorpCounts, listCorpRollups } from '../lib/api';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { usePrefetchers } from '../lib/prefetch';
import { money } from '../lib/format';
import { CardGridSkeleton } from '../components/Skeleton';
import CorporationProfileModal from '../components/CorporationProfileModal';
import { BuildingIcon } from '../components/icons';

const TITLES = { leases: 'Leases', financials: 'Financials', history: 'History' };
const SUBS = {
  leases: 'Pick a corporation to see its properties and leases.',
  financials: 'Revenue & expenses by corporation.',
  history: 'Year-over-year performance by corporation.',
};

// Shared by all three workspaces. `mode` sets the link base; corporation data is identical.
export default function CorporationsPage({ mode }) {
  usePageChrome([{ label: TITLES[mode] }], mode !== 'leases');
  const qc = useQueryClient();
  const { year } = useChrome();
  const pf = usePrefetchers();
  const fin = mode !== 'leases';
  const [name, setName] = useState('');
  const [editCorp, setEditCorp] = useState(null);

  const { data: corps = [], isPending } = useQuery({ queryKey: ['corporations'], queryFn: listCorporations });
  // Batched in one request (replaces the per-card N+1) so every card's counts /
  // financials are ready before the grid renders — no number pop-in.
  const { data: counts = {}, isPending: countsPending } = useQuery({ queryKey: ['corpCounts'], queryFn: listCorpCounts });
  const { data: rollups = {}, isPending: rollupsPending } = useQuery({
    queryKey: ['corpRollups', year],
    queryFn: () => listCorpRollups(year),
    enabled: fin,
    placeholderData: keepPreviousData, // keep last year's numbers visible while a new year loads
  });

  const add = useMutation({
    mutationFn: () => createCorporation(name.trim()),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['corporations'] });
      qc.invalidateQueries({ queryKey: ['corpCounts'] });
    },
  });

  // Render the grid only once cards can appear fully populated in one pass.
  const showSkeleton = isPending || (corps.length > 0 && (countsPending || (fin && rollupsPending)));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Corporations</h1>
          <div className="muted">{SUBS[mode]}</div>
        </div>
        <div className="head-actions">
          <form
            className="row"
            onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}
          >
            <input
              className="text-input"
              placeholder="New corporation name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" disabled={!name.trim() || add.isPending}>+ New corporation</button>
          </form>
        </div>
      </div>

      {showSkeleton ? (
        <CardGridSkeleton className="corp-grid" count={3} height={fin ? 150 : 92} />
      ) : corps.length === 0 ? (
        <p className="muted">No corporations yet.</p>
      ) : (
        <div className="corp-grid">
          {corps.map((c) => (
            <CorpCard key={c.id} corp={c} mode={mode} onEdit={setEditCorp} counts={counts[c.id]} rollup={rollups[c.id]} pf={pf} year={year} />
          ))}
        </div>
      )}

      {editCorp && <CorporationProfileModal corp={editCorp} onClose={() => setEditCorp(null)} />}
    </div>
  );
}

function CorpCard({ corp, mode, onEdit, counts, rollup, pf, year }) {
  const navigate = useNavigate();
  const fin = mode !== 'leases';
  const initials = corp.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const sub = counts ? `${counts.properties} ${counts.properties === 1 ? 'property' : 'properties'} · ${counts.tenants} ${counts.tenants === 1 ? 'tenant' : 'tenants'}` : '…';
  const go = () => navigate(`/${mode}/${corp.id}`);
  const keyGo = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  // Warm the next page on hover/focus so the click lands on already-cached data.
  const warm = fin ? () => pf.corpFinancials(corp.id, year) : () => pf.corpLeases(corp.id);
  const hover = { onMouseEnter: warm, onFocus: warm };
  const editBtn = (
    <button
      className="corp-edit"
      title="Edit this corporation's email identity (name, address, sending email)"
      onClick={(e) => { e.stopPropagation(); onEdit(corp); }}
    >
      <BuildingIcon /> Business profile
    </button>
  );

  if (fin) {
    return (
      <div className="corp-card fin" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo} {...hover}>
        <span className="corp-head">
          <span className="corp-badge">{initials}</span>
          <span className="corp-info"><strong>{corp.name}</strong><span className="muted">{sub}</span></span>
          {editBtn}
        </span>
        <span className="corp-fin">
          <div><span className="muted">Revenue</span><b className="pos">{money(rollup?.revenue ?? 0)}</b></div>
          <div><span className="muted">Expenses</span><b className="neg">{money(rollup?.expenses ?? 0)}</b></div>
          <div><span className="muted">NOI</span><b>{money(rollup?.noi ?? 0)}</b></div>
        </span>
      </div>
    );
  }

  return (
    <div className="corp-card" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo} {...hover}>
      <span className="corp-badge">{initials}</span>
      <span className="corp-info"><strong>{corp.name}</strong><span className="muted">{sub}</span></span>
      {editBtn}
      <span className="chevron">›</span>
    </div>
  );
}
