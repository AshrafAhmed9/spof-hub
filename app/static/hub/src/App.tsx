import { lazy, Suspense, useState, type Dispatch, type SetStateAction } from 'react';
import Tabs, { Tab, TabList, TabPanel } from '@atlaskit/tabs';
import Lozenge from '@atlaskit/lozenge';
import Button from '@atlaskit/button/new';
import { api, setApiMode } from './api';
import type { UndoResult } from '../../../shared/contract';
import { Coverage, type Nav } from './Coverage';
import type { Run } from './Plans';
import SectionMessage from '@atlaskit/section-message';
import { AppHeader, EmptyState, ErrorPanel, Loading, SampleBanner, useFocusHeading } from './common';
import { useHost } from './host';
import { IssuePanel } from './IssuePanel';
import { fmtTime, plural } from './util';

const Timeline = lazy(() => import('./Timeline').then((m) => ({ default: m.Timeline })));
const Plans = lazy(() => import('./Plans').then((m) => ({ default: m.Plans })));
const Setup = lazy(() => import('./Setup').then((m) => ({ default: m.Setup })));

const TABS = ['Coverage', 'Plans', 'Timeline', 'Activity', 'Setup'] as const;

export function App() {
  const [tab, setTab] = useState(0);
  const [nav, setNav] = useState<Nav>({ view: 'hub' });
  const [leaver, setLeaver] = useState<string | undefined>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [undoOut, setUndoOut] = useState<Record<string, UndoResult | unknown>>({});
  const [mode, setMode] = useState<'live' | 'sample'>('live');
  const [epoch, setEpoch] = useState(0);
  const host = useHost();

  const switchMode = (m: 'live' | 'sample') => { setApiMode(m); setMode(m); setNav({ view: 'hub' }); setTab(0); setEpoch((n) => n + 1); };
  const goPlan = (id: string) => { setLeaver(id); setTab(1); };

  if (host?.issueKey) return <div className="page panel"><IssuePanel issueKey={host.issueKey} /></div>;

  const view = (i: number) => {
    switch (i) {
      case 0: return <Coverage key={`c${epoch}`} nav={nav} setNav={setNav} onPlan={goPlan} onSetup={() => setTab(4)} onSample={mode === 'live' ? () => switchMode('sample') : undefined} />;
      case 1: return (
        <Plans key={`p${epoch}`} initialLeaver={leaver} mode={mode} onSetup={() => setTab(4)}
          onRun={(r) => setRuns((x) => [r, ...x])}
          onRunUpdate={(k, p) => setRuns((x) => x.map((r) => (r.planKey === k ? { ...r, ...p } : r)))} />
      );
      case 2: return <Timeline key={`t${epoch}`} mode={mode} onSetup={() => setTab(4)} />;
      case 3: return <Activity runs={runs} out={undoOut} setOut={setUndoOut} onPlan={() => setTab(1)} onUndone={(k) => setRuns((x) => x.map((r) => (r.planKey === k ? { ...r, undone: true } : r)))} />;
      default: return <Setup key={`s${epoch}`} />;
    }
  };

  return (
    <div className="page">
      {host?.product === 'confluence' && <AppHeader />}
      {mode === 'sample' && <SampleBanner onSetup={() => setTab(4)} onLive={() => switchMode('live')} />}
      <main>
        <Tabs id="main" selected={tab} onChange={(i) => { setTab(i); if (i === 0) setNav({ view: 'hub' }); }}>
          <div className="tabs-wrap"><TabList>{TABS.map((t) => <Tab key={t}>{t}</Tab>)}</TabList></div>
          {TABS.map((t, i) => (
            <TabPanel key={t}>
              <Suspense fallback={<Loading label="Loading" rows={3} />}>
                {tab === i && view(i)}
              </Suspense>
            </TabPanel>
          ))}
        </Tabs>
      </main>
    </div>
  );
}

function Activity({ runs, out, setOut, onPlan, onUndone }: { runs: Run[]; out: Record<string, UndoResult | unknown>; setOut: Dispatch<SetStateAction<Record<string, UndoResult | unknown>>>; onPlan: () => void; onUndone: (planKey: string) => void }) {
  const h = useFocusHeading('activity');
  const [busy, setBusy] = useState<string | null>(null);
  const undo = (planKey: string) => {
    setBusy(planKey);
    api.undoPlan(planKey).then(
      (r) => { setOut((o) => ({ ...o, [planKey]: r })); setBusy(null); if (r.failed.length === 0) onUndone(planKey); },
      (e) => { setOut((o) => ({ ...o, [planKey]: e })); setBusy(null); },
    );
  };
  return (
    <div className="stack">
      <div className="stack-sm">
        <h1 ref={h} tabIndex={-1}>Activity</h1>
        <p className="subtle">Plans you applied during this visit.</p>
      </div>
      <div className="note" role="note">
        Runs from this visit are listed here, and Undo works from here. Runs from earlier visits aren't listed.
      </div>
      {runs.length === 0 ? (
        <EmptyState title="No runs in this visit" body="When you apply a plan, it shows up here with what was done and what was skipped.">
          <Button appearance="primary" onClick={onPlan}>Plan time off or leaving</Button>
        </EmptyState>
      ) : (
        <ul className="card" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {runs.map((r) => {
            const o = out[r.planKey];
            const res = o && typeof o === 'object' && 'reverted' in o ? (o as UndoResult) : null;
            return (
              <li key={r.planKey + r.at} className="card-pad stack-sm" style={{ borderBottom: '1px solid var(--ds-border,#dcdfe4)' }}>
                <div>
                  <strong>Cover for {r.leaverName}</strong>{' '}
                  {r.sample ? <Lozenge>Sample only</Lozenge> : r.undone ? <Lozenge>Undone</Lozenge> : <Lozenge appearance="success">Applied</Lozenge>}
                  <div className="subtle">{fmtTime(r.at)}, by you. {r.sample ? 'Nothing was written.' : `${r.done} done, ${r.failed} skipped.`}</div>
                </div>
                {!r.sample && !r.undone && r.done > 0 && (
                  <div className="row"><Button onClick={() => undo(r.planKey)} isDisabled={busy !== null}>{busy === r.planKey ? 'Undoing' : res ? 'Undo again' : 'Undo this run'}</Button></div>
                )}
                {res && res.failed.length > 0 && (
                  <SectionMessage appearance="warning" title={`Undid ${res.reverted}, but ${res.failed.length} could not be put back`}>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>{res.failed.map((f) => <li key={f.itemId}>{f.itemId}: {f.reason}</li>)}</ul>
                  </SectionMessage>
                )}
                {res && res.failed.length === 0 && <p role="status">{`Undone. ${plural(res.reverted, 'item')} put back as before.`}</p>}
                {o != null && !res && <ErrorPanel error={o} what="that" unchanged={false} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
