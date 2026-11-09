import Drawer from '@atlaskit/drawer';
import Button from '@atlaskit/button/new';
import type { PlanEntry } from './api';
import { pct } from './util';

/** The only place raw numbers appear. */
export function WhyDrawer({ entry: e, leaver, isOpen, onClose, chosenName }: {
  entry: PlanEntry; leaver: string; isOpen: boolean; onClose: () => void; chosenName?: string;
}) {
  const b = e.breakdown;
  const s = e.successor;
  return (
    <Drawer isOpen={isOpen} onClose={onClose} width="narrow" label={`Why ${e.title} is flagged`}>
      <div className="stack" style={{ padding: 'var(--ds-space-200,16px)' }}>
        <h2>Why this is flagged</h2>
        <p className="subtle">{e.title}</p>
        <section className="stack-sm" aria-label="Reasons">
          <h3>In plain words</h3>
          <ul style={{ margin: 0, paddingLeft: 20 }}>{e.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </section>
        <section className="stack-sm" aria-label="Signal breakdown">
          <h3>Signals for {leaver}</h3>
          <dl className="facts">
            <dt>Share of knowledge held</dt><dd>{pct(b.concentration)}</dd>
            <dt>Priority weight</dt><dd>{b.exposure.priority.toFixed(2)}</dd>
            <dt>Due-date weight</dt><dd>{b.exposure.due.toFixed(2)}</dd>
            <dt>Still open</dt><dd>{b.exposure.open ? 'Yes' : 'No'}</dd>
            <dt>Risk from this item</dt><dd>{b.own.toFixed(2)}</dd>
            <dt>Risk picked up from related items</dt><dd>{b.inherited.toFixed(2)}</dd>
            <dt><strong>Total risk</strong></dt><dd><strong>{b.total.toFixed(2)}</strong></dd>
            {b.via && (<><dt>Related item</dt><dd>{b.via}</dd></>)}
          </dl>
        </section>
        {s && (
          <section className="stack-sm" aria-label="Suggested cover">
            <h3>Suggested cover: {s.name}</h3>
            <dl className="facts">
              <dt>Fit score</dt><dd>{s.score.toFixed(2)}</dd>
              <dt>Closeness to this item</dt><dd>{s.ppr.toFixed(2)}</dd>
              <dt>Current workload</dt><dd>{pct(s.load)}</dd>
            </dl>
            <ul className="evidence" style={{ margin: 0 }}>{s.evidence.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </section>
        )}
        {chosenName && chosenName !== s?.name && <p className="small subtle">You picked {chosenName} instead. The numbers above describe the original suggestion.</p>}
        <p className="small subtle">Scores describe the work, not people's performance.</p>
        <div className="row"><Button onClick={onClose}>Close</Button></div>
      </div>
    </Drawer>
  );
}
