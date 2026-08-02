import { useQuery } from '@tanstack/react-query';
import { getAnnualReport } from '../lib/api';
import { fmtShortDate } from '../lib/format';
import { useModalA11y } from './modalA11y';
import { BuildingIcon, DocIcon } from './icons';

// One door to everything a corporation produces on paper.
//
// ⚠ WHY THIS EXISTS AT ALL, and it is a bug fix before it is a feature. Rounds 12–14 each
// added a pill to the corporation card until there were five, and `.corp-actions` claims
// its full max-content width as a flex item — so on a 320px card the row measured 617px
// and the last three buttons were painted OUTSIDE the card, underneath its neighbour.
// `elementFromPoint` at their centre returned the NEXT card. So "Tax package" on any card
// that wasn't last in its row was unclickable, and it read as "the download is broken."
// One control cannot overflow.
//
// The second thing it fixes is that five bare nouns say nothing. A landlord looking at
// "1099s" has no way to know whether it concerns them, so every row states in one plain
// sentence what it is and who it goes to. Grouping does the rest: what the COMPANY needs
// on file, versus what you HAND to someone.
//
// No new state machine — the page already owns one setter per modal, so a row simply
// calls the one it belongs to and closes itself. Nothing is stored and no figure moves.
export default function DocumentsFilingsModal({ corp, fin, onEdit, onAnnual, onCpa, on1099, onLender, onClose }) {
  const modalRef = useModalA11y(onClose);

  // Same query key the annual-report modal uses, so opening it next is a cache hit.
  // Its only job here is the deadline chip — a filing date you can see without
  // opening anything is the whole reason this row is worth a chip.
  const { data: report } = useQuery({
    queryKey: ['annualReport', corp.id],
    queryFn: () => getAnnualReport(corp.id),
  });

  const pick = (open) => () => { onClose(); open(corp); };

  const groups = [
    {
      title: 'The company',
      items: [
        {
          key: 'profile',
          icon: <BuildingIcon />,
          label: 'Business profile',
          what: 'The address and email that appear on letters you send.',
          go: pick(onEdit),
        },
        {
          key: 'annual',
          icon: <DocIcon />,
          label: 'Annual report',
          what: 'Your state filing deadline, and the reminder before it.',
          chip: report?.due_date ? `due ${fmtShortDate(report.due_date)}` : 'no date set',
          chipWarn: !report?.due_date,
          go: pick(onAnnual),
        },
      ],
    },
  ];

  // The three exports only exist on the Financials/History cards, where a fiscal year is
  // in scope. On the Portfolio tab there is no year to build a package for.
  if (fin) {
    groups.push({
      title: 'Things you hand someone',
      items: [
        {
          key: 'cpa',
          icon: <DocIcon />,
          label: 'Tax package',
          what: 'Income and expenses sorted the way a tax return wants them. For your accountant.',
          go: pick(onCpa),
        },
        {
          key: '1099',
          icon: <DocIcon />,
          label: '1099s',
          what: 'Contractors you paid enough that the IRS wants a form. Due January 31.',
          go: pick(on1099),
        },
        {
          key: 'lender',
          icon: <DocIcon />,
          label: 'Lender package',
          what: 'What a bank asks for when you apply for a loan or refinance.',
          go: pick(onLender),
        },
      ],
    });
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${corp.name} — documents and filings`}
        tabIndex={-1}
        style={{ width: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <strong>{corp.name}</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body docfile-body">
          {groups.map((g) => (
            <div key={g.title} className="docfile-group">
              <div className="docfile-group-head">{g.title}</div>
              {g.items.map((it) => (
                <button key={it.key} type="button" className="docfile-row" onClick={it.go}>
                  <span className="docfile-ico">{it.icon}</span>
                  <span className="docfile-text">
                    <span className="docfile-name">
                      {it.label}
                      {it.chip && (
                        <span className={`docfile-chip${it.chipWarn ? ' warn' : ''}`}>{it.chip}</span>
                      )}
                    </span>
                    <span className="docfile-what">{it.what}</span>
                  </span>
                  <span className="docfile-caret" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
