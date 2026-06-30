import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCorporations, createCorporation, getCorpCounts, getCorpRollup } from '../lib/api';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { money } from '../lib/format';
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
  const [name, setName] = useState('');
  const [editCorp, setEditCorp] = useState(null);
  const { data: corps = [], isLoading } = useQuery({
    queryKey: ['corporations'],
    queryFn: listCorporations,
  });
  const add = useMutation({
    mutationFn: () => createCorporation(name.trim()),
    onSuccess: () => {
      setName('');
      qc.invalidateQueries({ queryKey: ['corporations'] });
    },
  });

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

      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : corps.length === 0 ? (
        <p className="muted">No corporations yet.</p>
      ) : (
        <div className="corp-grid">
          {corps.map((c) => (
            <CorpCard key={c.id} corp={c} mode={mode} onEdit={setEditCorp} />
          ))}
        </div>
      )}

      {editCorp && <CorporationProfileModal corp={editCorp} onClose={() => setEditCorp(null)} />}
    </div>
  );
}

function CorpCard({ corp, mode, onEdit }) {
  const navigate = useNavigate();
  const { year } = useChrome();
  const fin = mode !== 'leases';
  const { data: counts } = useQuery({ queryKey: ['corpCounts', corp.id], queryFn: () => getCorpCounts(corp.id) });
  const { data: rollup } = useQuery({
    queryKey: ['corpRollup', corp.id, year],
    queryFn: () => getCorpRollup(corp.id, year),
    enabled: fin,
  });
  const initials = corp.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const sub = counts ? `${counts.properties} ${counts.properties === 1 ? 'property' : 'properties'} · ${counts.tenants} ${counts.tenants === 1 ? 'tenant' : 'tenants'}` : '…';
  const go = () => navigate(`/${mode}/${corp.id}`);
  const keyGo = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
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
      <div className="corp-card fin" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo}>
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
    <div className="corp-card" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo}>
      <span className="corp-badge">{initials}</span>
      <span className="corp-info"><strong>{corp.name}</strong><span className="muted">{sub}</span></span>
      {editBtn}
      <span className="chevron">›</span>
    </div>
  );
}
