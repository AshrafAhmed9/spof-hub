import { useEffect, useState } from 'react';
import Lozenge from '@atlaskit/lozenge';
import { api } from './api';
import type { IssueKnowledge } from '../../../shared/contract';
import { ErrorPanel, Loading, ShareBar } from './common';
import { fmtDate, plural } from './util';

/** Compact view for the Jira issue side panel: who holds the knowledge on this one issue. */
export function IssuePanel({ issueKey }: { issueKey: string }) {
  const [state, setState] = useState<{ s: 'loading' } | { s: 'ok'; v: IssueKnowledge } | { s: 'error'; e: unknown }>({ s: 'loading' });
  const load = () => {
    setState({ s: 'loading' });
    api.getIssueKnowledge(issueKey).then((v) => setState({ s: 'ok', v }), (e) => setState({ s: 'error', e }));
  };
  useEffect(load, [issueKey]);

  if (state.s === 'loading') return <Loading label="Checking who knows this" rows={2} />;
  if (state.s === 'error') return <ErrorPanel error={state.e} onRetry={load} what="this check" />;
  const v = state.v;

  if (v.state === 'not-indexed') {
    return <p className="panel-note">Not scanned yet. Open Depth Chart from the Apps menu and run a scan to see who knows this issue.</p>;
  }
  if (v.state === 'hidden') {
    return <p className="panel-note">You can't see this issue's history, so nothing is shown.</p>;
  }
  if (!v.holder) {
    return <p className="panel-note">No recorded activity yet, so nobody holds knowledge on it.</p>;
  }
  return (
    <section className="stack-sm" aria-label="Who knows this issue">
      <p className="panel-lead">
        <strong>{v.holder.name}</strong> {v.singlePoint ? 'holds most of what is known here' : 'has done most of the work here'}.
      </p>
      <ShareBar share={v.holder.share} who={v.holder.name} label={`on ${v.key}`} />
      <p className="subtle">
        {plural(v.contributions ?? 0, 'contribution')} recorded.
        {v.assignee === null && v.singlePoint ? ' Not assigned to them, so it will not show on their list.' : ''}
      </p>
      {v.singlePoint ? <Lozenge appearance="removed">Depends on one person</Lozenge> : <Lozenge appearance="success">Shared</Lozenge>}
      {!!v.evidence?.length && <ul className="evidence">{v.evidence.map((x) => <li key={x}>{x}</li>)}</ul>}
      {v.indexedAt && <p className="subtle">Last scanned {fmtDate(v.indexedAt)}.</p>}
    </section>
  );
}
