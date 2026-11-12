import { useCallback, useEffect, useState } from 'react';
import Button from '@atlaskit/button/new';
import { api } from './api';
import type { SetupCheck, SetupStatus } from '../../../shared/contract';
import { ErrorPanel, Loading, useFocusHeading } from './common';
import { fmtTime } from './util';

const LABELS: Record<SetupCheck['id'], string> = {
  'jira-scopes': 'Jira read access',
  'teamwork-graph': 'Teamwork Graph',
  rovo: 'Rovo agent',
  mcp: 'Connecting other tools (MCP)',
  index: 'Scan data',
};
const ORDER: SetupCheck['id'][] = ['jira-scopes', 'teamwork-graph', 'rovo', 'mcp', 'index'];

export function Setup() {
  const [s, setS] = useState<SetupStatus | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const h = useFocusHeading('setup');
  const load = useCallback(() => {
    setBusy(true); setErr(null);
    api.getSetupStatus().then((v) => { setS(v); setAt(Date.now()); setBusy(false); }, (e) => { setErr(e); setBusy(false); });
  }, []);
  useEffect(load, [load]);

  const checks = s ? [...s.checks].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)) : [];
  const bad = checks.filter((c) => !c.ok && c.status !== 'unknown').length;
  const unknown = checks.filter((c) => c.status === 'unknown').length;
  return (
    <div className="stack">
      <div className="row-between">
        <div className="stack-sm">
          <h1 ref={h} tabIndex={-1}>Setup check</h1>
          {s && <p className="subtle" aria-live="polite">{bad === 0 ? (unknown ? `Everything we can check is working. ${unknown} could not be checked from here.` : 'Everything is working.') : `${bad} ${bad === 1 ? 'thing needs' : 'things need'} attention.`} Last checked {fmtTime(at)}.</p>}
        </div>
        <Button onClick={load} isDisabled={busy}>{busy ? 'Checking' : 'Check again'}</Button>
      </div>
      {!s && !err && <Loading label="Checking setup" rows={5} />}
      {err != null && <ErrorPanel error={err} onRetry={load} what="the setup check" />}
      {s && (
        <ul className="card" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {checks.map((c) => (
            <li key={c.id} className="card-pad" style={{ borderBottom: '1px solid var(--ds-border,#dcdfe4)' }}>
              <div className="row">
                <span className={`status ${c.status === 'unknown' ? '' : c.ok ? 'ok' : 'warn'}`}>
                  <span aria-hidden="true">{c.status === 'unknown' ? '?' : c.ok ? '✓' : '!'}</span>{c.status === 'unknown' ? 'Not checked' : c.ok ? 'OK' : 'Needs attention'}
                </span>
                <strong>{LABELS[c.id]}</strong>
              </div>
              <p className="subtle" style={{ marginTop: 4 }}>{c.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
