import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { listCorporations, createCorporation, listCorpCounts, listCorpRollups, listPropertiesByCorps, listEntityLedgerByCorps } from '../lib/api';
import { summarizeEntityLedger } from '../lib/entityLedger';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { usePrefetchers } from '../lib/prefetch';
import { money } from '../lib/format';
import { CardGridSkeleton } from '../components/Skeleton';
import CorporationProfileModal from '../components/CorporationProfileModal';
import AnnualReportModal from '../components/AnnualReportModal';
import ExportCpaModal from '../components/ExportCpaModal';
import { BuildingIcon, DocIcon } from '../components/icons';

const TITLES = { leases: 'Portfolio', financials: 'Financials', history: 'History' };
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
  const [arCorp, setArCorp] = useState(null);
  const [cpaCorp, setCpaCorp] = useState(null);

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
  // Slice 4b — what the OWNER took out and what the LLC itself cost, per corporation.
  // Kept apart from the roll-up above rather than folded into "Expenses": a draw is
  // not an expense, and an entity cost is not any building's.
  const { data: entityByCorp = {} } = useQuery({
    queryKey: ['entityLedgerByCorps', year],
    queryFn: () => listEntityLedgerByCorps(year),
    enabled: fin,
    placeholderData: keepPreviousData,
  });
  // Properties per corporation, for the hover fly-out that jumps straight to one. One
  // batched query for the whole grid; keyed on the corp id set so it refetches on add/remove.
  const corpIds = corps.map((c) => c.id);
  const { data: corpProps = {} } = useQuery({
    queryKey: ['corpProperties', corpIds.join(',')],
    queryFn: () => listPropertiesByCorps(corpIds),
    enabled: corps.length > 0,
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
          <h1>{TITLES[mode]}</h1>
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
            <CorpCard key={c.id} corp={c} mode={mode} onEdit={setEditCorp} onAnnual={setArCorp} onCpa={setCpaCorp} counts={counts[c.id]} rollup={rollups[c.id]} entity={summarizeEntityLedger(entityByCorp[c.id] || [])} properties={corpProps[c.id] || []} pf={pf} year={year} />
          ))}
        </div>
      )}

      {editCorp && <CorporationProfileModal corp={editCorp} onClose={() => setEditCorp(null)} />}
      {arCorp && <AnnualReportModal corp={arCorp} onClose={() => setArCorp(null)} />}
      {cpaCorp && <ExportCpaModal corporationId={cpaCorp.id} corporationName={cpaCorp.name} year={year} onClose={() => setCpaCorp(null)} />}
    </div>
  );
}

function CorpCard({ corp, mode, onEdit, onAnnual, onCpa, counts, rollup, entity, properties = [], pf, year }) {
  const navigate = useNavigate();
  const fin = mode !== 'leases';
  const initials = corp.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const sub = counts ? `${counts.properties} ${counts.properties === 1 ? 'property' : 'properties'} · ${counts.tenants} ${counts.tenants === 1 ? 'tenant' : 'tenants'}` : '…';
  const go = () => navigate(`/${mode}/${corp.id}`);
  const keyGo = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  // Warm the next page on hover/focus so the click lands on already-cached data.
  const warm = fin ? () => pf.corpFinancials(corp.id, year) : () => pf.corpLeases(corp.id);
  const hover = { onMouseEnter: warm, onFocus: warm };

  // Hover/focus fly-out: jump straight to any property under this corporation, skipping
  // the corp landing page. Shown via CSS on :hover and :focus-within (keyboard: tab to
  // the card → the panel appears → tab into the links). A link click stops propagation so
  // it navigates to the property instead of the card's corp-level click.
  const flyout = properties.length > 0 && (
    <div className="corp-flyout" role="menu" aria-label={`Properties in ${corp.name}`}>
      <div className="corp-flyout-head">Go to a property</div>
      {properties.map((p) => (
        <Link
          key={p.id}
          role="menuitem"
          className="corp-flyout-item"
          to={`/${mode}/${corp.id}/${p.id}`}
          onClick={(e) => e.stopPropagation()}
        >
          {p.name || 'Unnamed property'}
        </Link>
      ))}
    </div>
  );
  const editBtn = (
    <span className="corp-actions">
      <button
        className="corp-edit"
        title="Edit this corporation's email identity (name, address, sending email)"
        onClick={(e) => { e.stopPropagation(); onEdit(corp); }}
      >
        <BuildingIcon /> Business profile
      </button>
      <button
        className="corp-edit"
        title="This corporation's yearly state annual-report filing deadline + reminders"
        onClick={(e) => { e.stopPropagation(); onAnnual(corp); }}
      >
        <DocIcon /> Annual report
      </button>
      {fin && (
        <button
          className="corp-edit"
          title="Download this entity's tax package for the selected year — income and expenses by tax category, the depreciation schedule, and what is deliberately left off"
          onClick={(e) => { e.stopPropagation(); onCpa(corp); }}
        >
          <DocIcon /> Tax package
        </button>
      )}
    </span>
  );

  if (fin) {
    return (
      <div className="corp-card fin has-flyout" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo} {...hover}>
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
        {/* Shown only when there is any — an always-present "$0 drawn" is noise, and
            the three-column grid above is deliberately fixed, so this sits under it
            rather than becoming a fourth column. */}
        {(entity?.draws > 0 || entity?.costs > 0 || entity?.contributions > 0) && (
          <span className="corp-entity muted" title="Owner draws and contributions move your equity; entity costs belong to the LLC rather than to a building. None of it is in the figures above.">
            {entity.draws > 0 && <>{money(entity.draws)} drawn</>}
            {entity.contributions > 0 && <>{entity.draws > 0 ? ' · ' : ''}{money(entity.contributions)} contributed</>}
            {entity.costs > 0 && <>{(entity.draws > 0 || entity.contributions > 0) ? ' · ' : ''}{money(entity.costs)} entity costs</>}
          </span>
        )}
        {flyout}
      </div>
    );
  }

  return (
    <div className="corp-card has-flyout" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo} {...hover}>
      <span className="corp-badge">{initials}</span>
      <span className="corp-info"><strong>{corp.name}</strong><span className="muted">{sub}</span></span>
      {editBtn}
      <span className="chevron">›</span>
      {flyout}
    </div>
  );
}
