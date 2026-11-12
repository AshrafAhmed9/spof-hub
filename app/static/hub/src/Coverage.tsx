import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '@atlaskit/button/new';
import Breadcrumbs, { BreadcrumbsItem } from '@atlaskit/breadcrumbs';
import Lozenge from '@atlaskit/lozenge';
import ProgressBar from '@atlaskit/progress-bar';
import { api, type PlanEntry } from './api';
import type { AreaCoverage, CoverageResponse, ScanProgress } from '../../../shared/contract';
import { EmptyState, ErrorPanel, ExternalLink, Loading, PartialNotice, PrimaryButton, ShareBar, useFocusHeading } from './common';
import { itemUrl, useHost } from './host';
import { DAY, fmtDate, fmtDateLong, fmtTime, plural, shareWords, shortName, todayDay } from './util';
const WhyDrawer = lazy(() => import('./WhyDrawer').then((m) => ({ default: m.WhyDrawer })));

export type Nav =
  | { view: 'hub' }
  | { view: 'area'; area: AreaCoverage }
  | { view: 'item'; area: AreaCoverage; entry: PlanEntry; from: number; to: number };

interface Props {
  nav: Nav;
  setNav: (n: Nav) => void;
  onPlan: (leaverId: string) => void;
  onSetup: () => void;
  onSample?: () => void;
}

export function Coverage({ nav, setNav, onPlan, onSetup, onSample }: Props) {
  if (nav.view === 'hub') return <Hub setNav={setNav} onSetup={onSetup} onSample={onSample} />;
  if (nav.view === 'area') return <Area area={nav.area} setNav={setNav} onPlan={onPlan} onSetup={onSetup} />;
  return <Item nav={nav} setNav={setNav} onPlan={onPlan} />;
}

/* ---------- hub ---------- */

type Load<T> = { s: 'loading' } | { s: 'error'; e: unknown } | { s: 'ok'; v: T };

function Hub({ setNav, onSetup, onSample }: { setNav: (n: Nav) => void; onSetup: () => void; onSample?: () => void }) {
  const [data, setData] = useState<Load<CoverageResponse>>({ s: 'loading' });
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [scanErr, setScanErr] = useState<unknown>(null);
  const [show, setShow] = useState<'attention' | 'all'>('attention');
  const h = useFocusHeading('hub');
  const timer = useRef<number>();
  const wasRunning = useRef(false); // reload only when a scan finishes, not whenever a poll sees 'done'

  const load = useCallback(() => {
    setData({ s: 'loading' });
    api.getCoverage().then((v) => setData({ s: 'ok', v }), (e) => setData({ s: 'error', e }));
  }, []);
  useEffect(load, [load]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const poll = useCallback(() => {
    api.getScanProgress().then((p) => {
      setScan(p);
      if (p.state === 'running') { wasRunning.current = true; timer.current = window.setTimeout(poll, 1500); }
      else if (p.state === 'done' && wasRunning.current) { wasRunning.current = false; load(); }
    }, (e) => { setScanErr(e); setScan(null); });
  }, [load]);
  // Pick up a scan that is already running when the page opens.
  useEffect(() => { poll(); return () => window.clearTimeout(timer.current); }, [poll]);

  const [scope, setScope] = useState('');
  const startScan = () => {
    setScanErr(null);
    wasRunning.current = true;
    // Optional project keys, so a big site can be scanned a project at a time.
    const keys = scope.split(/[\s,]+/).map((k) => k.trim().toUpperCase()).filter(Boolean);
    api.startScan(keys.length ? keys : undefined).then((p) => { setScan(p); timer.current = window.setTimeout(poll, 1500); }, (e) => setScanErr(e));
  };

  const scanning = scan?.state === 'running';

  // Announce only start, finish and failure, not each progress tick.
  const [announce, setAnnounce] = useState('');
  const prevState = useRef<ScanProgress['state'] | undefined>();
  useEffect(() => {
    const s = scan?.state;
    if (s === 'running' && prevState.current !== 'running') setAnnounce('Scan started');
    else if (s === 'done' && prevState.current === 'running') setAnnounce('Scan finished');
    else if (s === 'error' && prevState.current !== 'error') setAnnounce('Scan failed');
    prevState.current = s;
  }, [scan?.state]);
  useEffect(() => { if (scanErr != null) setAnnounce('Scan failed'); }, [scanErr]);

  const body = (() => {
    if (data.s === 'loading') return <Loading label="Loading coverage" />;
    if (data.s === 'error') return <ErrorPanel error={data.e} onRetry={load} what="coverage" />;
    const c = data.v;
    const noScan = c.totals.itemsScanned === 0;
    const needs = (a: AreaCoverage) => a.truckFactor <= 1 || a.singlePointItems > 0;
    const sorted = [...c.areas].sort((a, b) => a.truckFactor - b.truckFactor || b.singlePointItems - a.singlePointItems || b.items - a.items);
    const rows = show === 'attention' ? sorted.filter(needs) : sorted;

    return (
      <>
        {c.partial && c.notes.some((n) => !/index is empty/i.test(n)) && <PartialNotice notes={c.notes.filter((n) => !/index is empty/i.test(n))} onSetup={onSetup} />}
        {noScan && c.areas.length === 0 ? (
          <EmptyState
            title={scan?.state === 'done' ? 'The scan found no work items' : 'Nothing scanned yet'}
            body={scan?.state === 'done'
              ? 'This site has no work items we can read yet. Add some work in Jira and scan again' + (onSample ? ', or look around with the example company.' : '.')
              : onSample
                ? 'Scan this site to find work that depends on one person. Or look around first with an example company: nothing in your site changes.'
                : 'Scan this site to find work that depends on one person.'}
          >
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-end' }}>
              
              <PrimaryButton onClick={startScan} isDisabled={scanning}>{scanning ? 'Scanning' : 'Scan this site'}</PrimaryButton>
              {onSample && <Button onClick={onSample}>Explore the example company</Button>}
            </div>
          </EmptyState>
        ) : (
          <>
            <Hero c={c} attention={sorted.filter(needs).length} />
            <GraphNote c={c} />
            <div className="filters">
              <div className="field">
                <label htmlFor="show">Show</label>
                <select id="show" className="native" value={show} onChange={(e) => setShow(e.target.value as 'attention' | 'all')}>
                  <option value="attention">Needs attention ({sorted.filter(needs).length})</option>
                  <option value="all">All areas ({sorted.length})</option>
                </select>
              </div>
            </div>
            {rows.length === 0 ? (
              c.partial ? (
                <div className="note" role="note">No areas to show yet. Some sources were unavailable, so this isn't a clean result. Check the setup, then scan again.</div>
              ) : (
                <EmptyState title="No area is held by one person" body="Every area scanned has work spread across two or more people. Choose All areas to see them.">
                  <Button onClick={() => setShow('all')}>Show all areas</Button>
                </EmptyState>
              )
            ) : (
              <section className="card" style={{ overflow: 'hidden' }} aria-label="Areas, most urgent first">
                <ul className="arealist">
                  {rows.map((a) => (
                    <li key={a.area}>
                      <div className="area-main">
                        <div className="area-title">
                          <h2 className="h3like">{a.area}</h2>
                          {a.truckFactor <= 1 ? <Lozenge appearance="removed" isBold>One person</Lozenge>
                            : a.truckFactor === 2 ? <Lozenge appearance="moved">Two people</Lozenge>
                            : <Lozenge appearance="success">{a.truckFactor} people</Lozenge>}
                        </div>
                        <p>
                          {a.singlePointItems > 0
                            ? <>{plural(a.singlePointItems, 'item')} of {a.items.toLocaleString()} {a.singlePointItems === 1 ? 'depends' : 'depend'} on one person.</>
                            : <>{a.topPerson.name} holds {shareWords(a.topPerson.share)} of the knowledge across {plural(a.items, 'item')}.</>}
                          {a.unassignedToTop > 0 && <> {plural(a.unassignedToTop, 'item')} {a.unassignedToTop === 1 ? "isn't" : "aren't"} assigned to {a.topPerson.name}.</>}
                        </p>
                        <ShareBar share={a.topPerson.share} who={a.topPerson.name} label={`in ${a.area}`} />
                      </div>
                      <div className="area-side">
                        <span className="small subtle">Covered by {plural(a.truckFactor, 'person', 'people')}</span>
                        <Button appearance="subtle" onClick={() => setNav({ view: 'area', area: a })}>
                          Open<span className="sr-only"> {a.area}</span>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <p className="small subtle">Last scanned {fmtTime(c.generatedAt)}. Areas are sorted by how few people cover them. Scores describe the work, not people.</p>
          </>
        )}
      </>
    );
  })();

  return (
    <div className="stack">
      <div className="row-between">
        <div className="stack-sm">
          <h1 ref={h} tabIndex={-1}>Coverage</h1>
        </div>
        {!(data.s === 'ok' && data.v.totals.itemsScanned === 0 && data.v.areas.length === 0) && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <label className="scope">
                <span>Only these projects (optional)</span>
                <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. MOB, CX" disabled={scanning} />
              </label>
          <Button onClick={startScan} isDisabled={scanning}>{scanning ? 'Scanning' : 'Scan again'}</Button>
        </div>}
      </div>
      <p role="status" className="sr-only">{announce}</p>
      {scanning && scan && <ScanBar p={scan} />}
      {scan?.state === 'error' && <ErrorPanel error={new Error(scan.message ?? 'The scan stopped.')} onRetry={startScan} what="the scan" />}
      {scanErr != null && <ErrorPanel error={scanErr} onRetry={startScan} what="the scan" />}
      {body}
    </div>
  );
}

function Hero({ c, attention }: { c: CoverageResponse; attention: number }) {
  const n = c.totals.singlePointItems;
  const share = c.totals.itemsScanned > 0 ? Math.round((n / c.totals.itemsScanned) * 100) : 0;
  const calm = n === 0;
  return (
    <section className={`hero ${calm ? 'calm' : ''}`} aria-label="Summary">
      <p className="eyebrow">Where work depends on one person</p>
      <p className={`headline ${calm ? 'calm' : ''}`}>
        {calm ? <><span className="hl">Nothing</span> relies on a single person right now.</>
          : <><span className="hl">{plural(n, 'item')}</span> {n === 1 ? 'depends' : 'depend'} on just one person.</>}
      </p>
      {!calm && (
        <p className="lede">
          That is {share}% of the {plural(c.totals.itemsScanned, 'work item')} scanned.
          {c.totals.invisibleToAssignee > 0 && <> {plural(c.totals.invisibleToAssignee, 'item')} {c.totals.invisibleToAssignee === 1 ? 'is' : 'are'} not assigned to the person who knows it best, so {c.totals.invisibleToAssignee === 1 ? 'it' : 'they'} won't show up on their list.</>}
          {(c.totals.singleAuthorPages ?? 0) > 0 && <> Separately, {plural(c.totals.singleAuthorPages!, 'page')} of {(c.totals.pagesScanned ?? 0).toLocaleString()} {c.totals.singleAuthorPages === 1 ? 'has' : 'have'} a single author.</>}
        </p>
      )}
      <ul className="stats" aria-label="Totals">
        <li><span className="v">{c.totals.itemsScanned.toLocaleString()}</span><span className="k">work items scanned</span></li>
        <li><span className="v">{n.toLocaleString()}</span><span className="k">{n === 1 ? 'item' : 'items'} on one person</span></li>
        <li><span className="v">{attention.toLocaleString()}</span><span className="k">{attention === 1 ? 'area needs' : 'areas need'} attention</span></li>
      </ul>
    </section>
  );
}

function GraphNote({ c }: { c: CoverageResponse }) {
  const t = c.teamworkGraph;
  if (!t) return null;
  const kinds = (o: Record<string, number>) => Object.entries(o).filter(([, v]) => v > 0).map(([k, v]) => `${v.toLocaleString()} ${k.endsWith('s') || v === 1 ? k : k + 's'}`).join(', ');
  const a = t.ablation;
  const added = t.itemsOnlyFromGraph + t.edgesOnlyFromGraph;
  return (
    <section className="card card-pad stack-sm" aria-label="What Teamwork Graph adds">
      <p className="eyebrow">What Teamwork Graph adds</p>
      {added === 0 ? (
        <p>Teamwork Graph returned nothing beyond what Jira already gave, so the numbers above come from them alone.</p>
      ) : (
        <>
          <p>
            Teamwork Graph supplied {t.itemsOnlyFromGraph > 0 ? <>{kinds(t.byKind.items)} that Jira did not give, and </> : null}
            {t.edgesOnlyFromGraph.toLocaleString()} {t.edgesOnlyFromGraph === 1 ? 'link' : 'links'} between people and work{t.edgesOnlyFromGraph > 0 && Object.keys(t.byKind.edges).length > 0 ? <> ({kinds(t.byKind.edges)})</> : null}.
          </p>
          {a && (
            <p>
              With it, {plural(a.withGraph.singlePointItems, 'item')} depend{a.withGraph.singlePointItems === 1 ? 's' : ''} on one person. From Jira alone the count is {a.restOnly.singlePointItems.toLocaleString()}.
              {a.withGraph.singlePointItems < a.restOnly.singlePointItems && ' It can go down, because reviews and goal ownership show that some work is shared more widely than comments suggest.'}
            </p>
          )}
        </>
      )}
      {t.withheldRecords > 0 && <p className="subtle">{plural(t.withheldRecords, 'record')} belong to another person's view and are left out.</p>}
    </section>
  );
}

function ScanBar({ p }: { p: ScanProgress }) {
  const ratio = p.total > 0 ? p.done / p.total : 0;
  return (
    <div className="card card-pad stack-sm">
      <p>
        <strong>{p.message ?? 'Scanning'}</strong>: {p.done.toLocaleString()} of {p.total.toLocaleString()} items.
        {' '}<span className="subtle">{p.needsPage ? 'Keep this page open until it finishes.' : 'You can leave this page; it keeps going.'}</span>
      </p>
      <ProgressBar ariaLabel="Scan progress" value={ratio} />
    </div>
  );
}

/* ---------- area ---------- */

const windowDefault = () => { const from = todayDay(); return { from, to: from + 41 * DAY }; };

function Area({ area, setNav, onPlan, onSetup }: { area: AreaCoverage; setNav: (n: Nav) => void; onPlan: (id: string) => void; onSetup: () => void }) {
  const win = useMemo(windowDefault, []);
  const host = useHost();
  const [data, setData] = useState<Load<{ entries: PlanEntry[]; partial: boolean; notes: string[] }>>({ s: 'loading' });
  const h = useFocusHeading(area.area);
  const load = useCallback(() => {
    setData({ s: 'loading' });
    api.buildPlan({ leaverId: area.topPerson.id, ...win }).then(
      (r) => setData({ s: 'ok', v: { entries: r.plan.groups.filter((g) => g.area === area.area).flatMap((g) => g.entries), partial: r.partial, notes: r.notes } }),
      (e) => setData({ s: 'error', e }),
    );
  }, [area, win]);
  useEffect(load, [load]);

  return (
    <div className="stack">
      <Crumbs items={[['Coverage', () => setNav({ view: 'hub' })], [area.area]]} />
      <div className="row-between">
        <div className="stack-sm">
          <h1 ref={h} tabIndex={-1}>{area.area}</h1>
          <p className="subtle">
            {data.s === 'ok'
              ? `${plural(data.v.entries.length, 'item')} ${data.v.entries.length === 1 ? 'relies' : 'rely'} mostly on ${area.topPerson.name}. ${Math.max(0, area.items - data.v.entries.length)} are covered by two or more.`
              : `${plural(area.items, 'item')} scanned here.`}
          </p>
        </div>
        <Button onClick={() => onPlan(area.topPerson.id)}>Plan time off for {shortName(area.topPerson.name)}</Button>
      </div>
      {data.s === 'loading' && <Loading label="Loading items" />}
      {data.s === 'error' && <ErrorPanel error={data.e} onRetry={load} what="the items in this area" />}
      {data.s === 'ok' && (
        <>
          {data.v.partial && <PartialNotice notes={data.v.notes} onSetup={onSetup} />}
          {data.v.entries.length === 0 ? (
            data.v.partial ? <p className="subtle">No items to show, but results are incomplete.</p>
              : <EmptyState title="Nothing here relies on one person" body="Nothing here relies on one person right now." />
          ) : (
            <div className="card" style={{ overflow: 'hidden' }}>
              <table className="list">
                <caption className="sr-only">Items in {area.area} that rely on {area.topPerson.name}</caption>
                <thead><tr><th scope="col">Item</th><th scope="col">Who knows it</th><th scope="col">Timing</th><th scope="col">Type</th></tr></thead>
                <tbody>
                  {data.v.entries.map((e) => (
                    <tr key={e.itemId}>
                      <td data-label="Item">
                        <button type="button" className="linkbtn" onClick={() => setNav({ view: 'item', area, entry: e, ...win })}>
                          {e.title}
                        </button>
                        <div className="small subtle">
                          {(() => {
                            const url = host ? itemUrl(e.itemId, host.siteUrl) : null;
                            const name = e.kind === 'page' ? 'page' : e.itemId;
                            return url
                              ? <ExternalLink url={url} label={`Open ${e.kind === 'page' ? `page ${e.title}` : e.itemId} in ${e.kind === 'page' ? 'Confluence' : 'Jira'}, new tab`}>{e.kind === 'page' ? 'Open page' : name}</ExternalLink>
                              : e.kind === 'page' ? 'Confluence page' : e.itemId;
                          })()}
                        </div>
                      </td>
                      <td data-label="Who knows it">
                        <div>{area.topPerson.name}, {shareWords(e.concentration)} of the work</div>
                        <ShareBar share={e.concentration} who={area.topPerson.name} />
                      </td>
                      <td data-label="Due">{e.dueDuringAbsence ? <Lozenge appearance="moved">Due while away</Lozenge> : <span className="subtle">Not due while away</span>}</td>
                      <td data-label="Type"><Lozenge>{e.kind === 'page' ? 'Page' : 'Work item'}</Lozenge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------- item ---------- */

function Item({ nav, setNav, onPlan }: { nav: Extract<Nav, { view: 'item' }>; setNav: (n: Nav) => void; onPlan: (id: string) => void }) {
  const { entry: e, area } = nav;
  const [why, setWhy] = useState(false);
  const h = useFocusHeading(e.itemId);
  const host = useHost();
  const url = host ? itemUrl(e.itemId, host.siteUrl) : null;
  const cands = [e.successor, ...e.alternates].filter((x): x is NonNullable<typeof x> => !!x);
  const first = shortName(area.topPerson.name);
  return (
    <div className="stack">
      <Crumbs items={[['Coverage', () => setNav({ view: 'hub' })], [area.area, () => setNav({ view: 'area', area })], [e.kind === 'page' ? e.title : e.itemId]]} />
      <div className="stack-sm">
        <h1 ref={h} tabIndex={-1}>{e.kind === 'page' ? e.title : `${e.itemId} ${e.title}`}</h1>
        {url && <p><ExternalLink url={url} label={`Open ${e.kind === 'page' ? e.title : e.itemId} in ${e.kind === 'page' ? 'Confluence' : 'Jira'}, new tab`}>{e.kind === 'page' ? 'Open this page in Confluence' : `Open ${e.itemId} in Jira`}</ExternalLink></p>}
        <p>
          Mostly {area.topPerson.name} has worked on this ({shareWords(e.concentration)} of it).{' '}
          <button type="button" className="linkbtn" onClick={() => setWhy(true)}>Why?</button>
        </p>
        <p className="subtle">
          Out from {fmtDateLong(nav.from)} to {fmtDate(nav.to)} (default window, change it in the plan).
          {e.dueDuringAbsence && ' This is due while they are away.'}
        </p>
      </div>
      <section className="card card-pad stack-sm" aria-labelledby="cover-h">
        <h2 id="cover-h">Who could cover</h2>
        {cands.length === 0 ? (
          <p className="subtle">No clear fit. You can still pick someone in the plan.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} className="stack-sm">
            {cands.map((c, i) => (
              <li key={c.personId}>
                <strong>{c.name}</strong>{i === 0 && <> <Lozenge appearance="success">Best fit</Lozenge></>}
                <ul className="evidence">{c.evidence.map((x, j) => <li key={j}>{x}</li>)}</ul>
              </li>
            ))}
          </ul>
        )}
        <div className="row"><PrimaryButton onClick={() => onPlan(area.topPerson.id)}>Add to {first}'s plan</PrimaryButton></div>
      </section>
      {why && <Suspense fallback={null}><WhyDrawer entry={e} leaver={area.topPerson.name} isOpen={why} onClose={() => setWhy(false)} /></Suspense>}
    </div>
  );
}

function Crumbs({ items }: { items: [string, (() => void)?][] }) {
  return (
    <Breadcrumbs label="Breadcrumb">
      {items.map(([text, fn], i) => (
        <BreadcrumbsItem key={i} text={text} href={fn ? '#' : undefined} onClick={fn ? (ev) => { ev.preventDefault(); fn(); } : undefined} aria-current={fn ? undefined : 'page'} />
      ))}
    </Breadcrumbs>
  );
}
