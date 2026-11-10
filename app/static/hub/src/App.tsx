import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import Tabs, { Tab, TabList, TabPanel } from '@atlaskit/tabs';
import Lozenge from '@atlaskit/lozenge';
import Button from '@atlaskit/button/new';
import { api, setApiMode } from './api';
import type { SetupStatus } from '../../../shared/contract';
import { Coverage, type Nav } from './Coverage';
import type { Run } from './Plans';
import { AppHeader, EmptyState, Loading, SampleBanner, useFocusHeading } from './common';
import { useHost } from './host';
import { IssuePanel } from './IssuePanel';
import { fmtTime } from './util';

const Timeline = lazy(() => import('./Timeline').then((m) => ({ default: m.Timeline })));
const Plans = lazy(() => import('./Plans').then((m) => ({ default: m.Plans })));
const Setup = lazy(() => import('./Setup').then((m) => ({ default: m.Setup })));

const TABS = ['Coverage', 'Plans', 'Timeline', 'Activity', 'Setup'] as const;

export function App() {
  const [tab, setTab] = useState(0);
  const [nav, setNav] = useState<Nav>({ view: 'hub' });
  const [leaver, setLeaver] = useState<string | undefined>();
  const [, setSetup] = useState<SetupStatus | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [mode, setMode] = useState<'live' | 'sample'>('live');
  const [epoch, setEpoch] = useState(0);
  const host = useHost();

  useEffect(() => { api.getSetupStatus().then(setSetup, () => undefined); }, [epoch]);
  const onStatus = useCallback((s: SetupStatus) => setSetup(s), []);
  const switchMode = (m: 'live' | 'sample') => { setApiMode(m); setMode(m); setNav({ view: 'hub' }); setTab(0); setEpoch((n) => n + 1); };
  const goPlan = (id: string) => { setLeaver(id); setTab(1); };

  if (host?.issueKey) return <div className="page panel"><IssuePanel issueKey={host.issueKey} /></div>;

  return (
    <div className="page">
      {host?.product === 'confluence' && <AppHeader />}
      {mode === 'sample' && <SampleBanner onSetup={() => setTab(4)} onLive={() => switchMode('live')} />}
      <div className="tabs-wrap">
        <Tabs id="main" selected={tab} onChange={(i) => { setTab(i); if (i === 0) setNav({ view: 'hub' }); }}>
          <TabList>{TABS.map((t) => <Tab key={t}>{t}</Tab>)}</TabList>
          {TABS.map((t) => <TabPanel key={t}><span className="sr-only">{t}</span></TabPanel>)}
        </Tabs>
      </div>
      <main>
        <Suspense fallback={<Loading label="Loading" rows={3} />}>
        {tab === 0 && <Coverage key={`c${epoch}`} nav={nav} setNav={setNav} onPlan={goPlan} onSetup={() => setTab(4)} onSample={mode === 'live' ? () => switchMode('sample') : undefined} />}
        {tab === 1 && (
          <Plans key={`p${epoch}`} initialLeaver={leaver} mode={mode} onSetup={() => setTab(4)}
            onRun={(r) => setRuns((x) => [r, ...x])}
            onRunUpdate={(k, p) => setRuns((x) => x.map((r) => (r.planKey === k ? { ...r, ...p } : r)))} />
        )}
        {tab === 2 && <Timeline key={`t${epoch}`} mode={mode} onSetup={() => setTab(4)} />}
        {tab === 3 && <Activity runs={runs} onPlan={() => setTab(1)} />}
        {tab === 4 && <Setup key={`s${epoch}`} onStatus={onStatus} />}
        </Suspense>
      </main>
    </div>
  );
}

function Activity({ runs, onPlan }: { runs: Run[]; onPlan: () => void }) {
  const h = useFocusHeading('activity');
  return (
    <div className="stack">
      <div className="stack-sm">
        <h1 ref={h} tabIndex={-1}>Activity</h1>
        <p className="subtle">Plans you applied during this visit.</p>
      </div>
      <div className="note" role="note">
        Runs from earlier visits aren't listed yet. The app only keeps this visit's runs on screen, and Undo is on the result screen right after you apply.
      </div>
      {runs.length === 0 ? (
        <EmptyState title="No runs in this visit" body="When you apply a plan, it shows up here with what was done and what was skipped.">
          <Button appearance="primary" onClick={onPlan}>Plan time off or leaving</Button>
        </EmptyState>
      ) : (
        <ul className="card" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {runs.map((r) => (
            <li key={r.planKey + r.at} className="card-pad" style={{ borderBottom: '1px solid var(--ds-border,#dcdfe4)' }}>
              <div>
                <strong>Cover for {r.leaverName}</strong>{' '}
                {r.sample ? <Lozenge>Sample only</Lozenge> : r.undone ? <Lozenge>Undone</Lozenge> : <Lozenge appearance="success">Applied</Lozenge>}
                <div className="subtle">{fmtTime(r.at)}, by you. {r.sample ? 'Nothing was written.' : `${r.done} done, ${r.failed} skipped.`}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
