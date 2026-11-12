import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Button from '@atlaskit/button/new';
import Checkbox from '@atlaskit/checkbox';
import Lozenge from '@atlaskit/lozenge';
import Select from '@atlaskit/select';
import Spinner from '@atlaskit/spinner';
import SectionMessage from '@atlaskit/section-message';
import { api, type HandoverPlan, type PlanEntry, type Person } from './api';
import type { ApplyResult, Mode, RescanResult, UndoResult } from '../../../shared/contract';
import { EmptyState, ErrorPanel, ExternalLink, Loading, PartialNotice, PrimaryButton, useFocusHeading } from './common';
import { itemUrl, useHost } from './host';
import { DAY, fmtDate, fmtDateLong, fromInputDate, opKeyFor, plural, todayDay, toInputDate } from './util';
const WhyDrawer = lazy(() => import('./WhyDrawer').then((m) => ({ default: m.WhyDrawer })));

export interface Run { planKey: string; leaverName: string; at: number; done: number; failed: number; undone: boolean; sample: boolean }

const APPLY_BATCH = 5;

type Phase = 'form' | 'review' | 'preview' | 'applying' | 'done';
type Opt = { value: string; label: string; evidence?: string[] };

const label = (e: PlanEntry) => (e.kind === 'page' ? e.title : `${e.itemId} ${e.title}`);

export function Plans({ initialLeaver, mode, onRun, onRunUpdate, onSetup }: {
  initialLeaver?: string; mode: Mode; onRun: (r: Run) => void; onRunUpdate: (planKey: string, patch: Partial<Run>) => void; onSetup: () => void;
}) {
  const sample = mode === 'sample';
  const host = useHost();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [peopleErr, setPeopleErr] = useState<unknown>(null);
  const [leaver, setLeaver] = useState(initialLeaver ?? '');
  const today = useMemo(() => todayDay(), []);
  const [from, setFrom] = useState(toInputDate(today));
  const [to, setTo] = useState(toInputDate(today + 41 * DAY));
  const [limit, setLimit] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [building, setBuilding] = useState(false);
  const [planErr, setPlanErr] = useState<unknown>(null);
  const [res, setRes] = useState<{ plan: HandoverPlan; partial: boolean; notes: string[] } | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [why, setWhy] = useState<PlanEntry | null>(null);
  const [applyErr, setApplyErr] = useState<unknown>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [rescan, setRescan] = useState<RescanResult | null>(null);
  const [undo, setUndo] = useState<UndoResult | null>(null);
  const [busy, setBusy] = useState<'rescan' | 'undo' | null>(null);
  const [followErr, setFollowErr] = useState<unknown>(null);
  const h = useFocusHeading(phase);

  const loadPeople = useCallback(() => {
    setPeopleErr(null);
    api.listPeople().then(setPeople, setPeopleErr);
  }, []);
  useEffect(loadPeople, [loadPeople]);
  useEffect(() => { if (initialLeaver) setLeaver(initialLeaver); }, [initialLeaver]);

  const dateBad = !from || !to || fromInputDate(to) < fromInputDate(from);
  const canBuild = !!leaver && !dateBad && !building;

  const build = () => {
    setBuilding(true); setPlanErr(null);
    api.buildPlan({ leaverId: leaver, from: fromInputDate(from), to: fromInputDate(to) + DAY - 1, ...(Number(limit) >= 1 ? { maxPerPerson: Math.floor(Number(limit)) } : {}) }).then(
      (r) => {
        setRes({ plan: r.plan, partial: r.partial, notes: r.notes });
        const c: Record<string, string> = {};
        for (const g of r.plan.groups) for (const e of g.entries) if (e.successor) c[e.itemId] = e.successor.personId;
        setChoice(c); setApproved(new Set()); setResult(null); setRescan(null); setUndo(null); setApplyErr(null); setFollowErr(null);
        setPhase('review'); setBuilding(false);
      },
      (e) => { setPlanErr(e); setBuilding(false); },
    );
  };

  const entries = useMemo(() => res?.plan.groups.flatMap((g) => g.entries) ?? [], [res]);
  const nameOf = (id: string) => people?.find((p) => p.id === id)?.name ?? entries.flatMap((e) => [e.successor, ...e.alternates]).find((s) => s?.personId === id)?.name ?? id;
  const optionsFor = (e: PlanEntry): Opt[] => {
    const seen = new Set<string>();
    const out: Opt[] = [];
    for (const s of [e.successor, ...e.alternates]) if (s && !seen.has(s.personId)) { seen.add(s.personId); out.push({ value: s.personId, label: s.name, evidence: s.evidence }); }
    for (const p of people ?? []) if (p.id !== res?.plan.leaverId && !seen.has(p.id)) { seen.add(p.id); out.push({ value: p.id, label: p.name, evidence: ['Picked by you'] }); }
    return out;
  };
  // A changed cover person has no engine-issued key, so derive it with the same recipe as the engine.
  const keyFor = (e: PlanEntry): string => {
    const c = choice[e.itemId]!;
    return e.successor && c === e.successor.personId ? e.operationKey : opKeyFor(res!.plan.planKey, e.itemId, c);
  };
  const approvable = entries.filter((e) => !!choice[e.itemId]);
  const approvedEntries = entries.filter((e) => approved.has(e.itemId) && choice[e.itemId]);
  const toggle = (id: string, on: boolean) => setApproved((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const toggleMany = (es: PlanEntry[], on: boolean) => setApproved((s) => {
    const n = new Set(s);
    es.forEach((e) => { if (!on) n.delete(e.itemId); else if (choice[e.itemId]) n.add(e.itemId); });
    return n;
  });

  const apply = async () => {
    if (!res) return;
    setPhase('applying'); setApplyErr(null);
    const planKey = res.plan.planKey;
    const sel = approvedEntries.map((e) => ({ itemId: e.itemId, key: keyFor(e) }));
    // Small batches keep each call well inside the platform time limit.
    const merged: ApplyResult = { planKey, done: [], failed: [], skippedSample: false };
    for (let i = 0; i < sel.length; i += APPLY_BATCH) {
      const part = sel.slice(i, i + APPLY_BATCH);
      try {
        const r = await api.applyPlan({ planKey, approvedOperationKeys: part.map((x) => x.key), choices: Object.fromEntries(part.map((x) => [x.itemId, choice[x.itemId]!])) });
        merged.done.push(...r.done); merged.failed.push(...r.failed);
        if (r.skippedSample) merged.skippedSample = true;
      } catch (e) {
        if (i === 0) { setApplyErr(e); setPhase('preview'); return; }
        const reason = 'The request stopped before this one finished, so it may or may not have gone through. Apply again to finish; anything already done is skipped.';
        for (const x of sel.slice(i)) merged.failed.push({ operationKey: x.key, itemId: x.itemId, reason });
        break;
      }
    }
    setResult(merged); setPhase('done');
    onRun({ planKey, leaverName: res.plan.leaverName, at: Date.now(), done: merged.done.length, failed: merged.failed.length, undone: false, sample: merged.skippedSample });
  };
  const doRescan = () => {
    if (!res) return;
    setBusy('rescan'); setFollowErr(null);
    api.rescan(res.plan.planKey).then((r) => { setRescan(r); setBusy(null); }, (e) => { setFollowErr(e); setBusy(null); });
  };
  const doUndo = () => {
    if (!res) return;
    setBusy('undo'); setFollowErr(null);
    api.undoPlan(res.plan.planKey).then((r) => { setUndo(r); setBusy(null); if (r.failed.length === 0) onRunUpdate(res.plan.planKey, { undone: true }); }, (e) => { setFollowErr(e); setBusy(null); });
  };

  const steps = ['Person and dates', 'Review', 'Preview', 'Result'];
  const stepIdx = phase === 'form' ? 0 : phase === 'review' ? 1 : phase === 'preview' || phase === 'applying' ? 2 : 3;
  const plan = res?.plan;

  return (
    <div className="stack">
      <div className="stack-sm">
        <h1 ref={h} tabIndex={-1}>Plan time off or leaving</h1>
        <ol className="steps" aria-label="Progress">
          {steps.map((s, i) => <li key={s} aria-current={i === stepIdx ? 'step' : undefined}>{i + 1}. {s}</li>)}
        </ol>
      </div>

      {phase === 'form' && (
        <form className="card card-pad stack" onSubmit={(ev) => { ev.preventDefault(); if (canBuild) build(); }} noValidate>
          {peopleErr != null && <ErrorPanel error={peopleErr} onRetry={loadPeople} what="the list of people" />}
          <div className="filters">
            <div className="field" style={{ minWidth: 240, flex: '1 1 240px' }}>
              <label htmlFor="who">Who is away</label>
              <Select
                inputId="who" menuPosition="fixed" placeholder={people ? 'Choose a person' : 'Loading people'} isLoading={!people && !peopleErr}
                options={(people ?? []).map((p) => ({ value: p.id, label: p.team ? `${p.name} (${p.team})` : p.name }))}
                value={leaver && people ? { value: leaver, label: nameOf(leaver) } : null}
                onChange={(o) => setLeaver((o as { value: string } | null)?.value ?? '')}
              />
            </div>
            <div className="field">
              <label htmlFor="from">Away from</label>
              <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-invalid={dateBad} aria-describedby={dateBad ? 'date-err' : undefined} />
            </div>
            <div className="field">
              <label htmlFor="to">Back after</label>
              <input id="to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-invalid={dateBad} aria-describedby={dateBad ? 'date-err' : undefined} />
            </div>
            <div className="field">
              <label htmlFor="limit">Most items per person</label>
              <input id="limit" type="number" inputMode="numeric" min={1} max={100} placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} aria-describedby="limit-help" />
              <span id="limit-help" className="hint">Optional. Spreads the work so nobody gets more than this.</span>
            </div>
          </div>
          {dateBad && <p id="date-err" role="alert" style={{ color: 'var(--ds-text-danger,#ae2e24)' }}>Pick an end date that is on or after the start date.</p>}
          {planErr != null && <ErrorPanel error={planErr} onRetry={build} what="the plan" />}
          <div className="row">
            <PrimaryButton type="submit" isDisabled={!canBuild}>{building ? 'Finding what needs cover' : 'Find what needs cover'}</PrimaryButton>
            {building && <Spinner size="small" label="Building plan" />}
          </div>
        </form>
      )}

      {plan && phase !== 'form' && (
        <p className="row">
          <strong>{plan.leaverName}</strong>
          <span className="subtle">out {fmtDateLong(plan.from)} to {fmtDate(plan.to)}</span>
          {phase === 'review' && <Button appearance="subtle" onClick={() => setPhase('form')}>Change person or dates</Button>}
        </p>
      )}

      {plan && res && (phase === 'review' || phase === 'preview') && (
        <>
          {res.partial && <PartialNotice notes={res.notes} onSetup={onSetup} />}
          {plan.groups.length === 0 ? (
            res.partial ? <p className="subtle">No items found, but results are incomplete.</p>
              : <EmptyState title="Nothing needs cover" body={`Nothing relies on ${plan.leaverName} for these dates.`} />
          ) : phase === 'review' ? (
            <>
              <div className="row-between">
                <p aria-live="polite">
                  <strong>{plural(plan.totals.items, 'item')}</strong> {plan.totals.items === 1 ? 'needs' : 'need'} cover.{' '}
                  {plan.totals.items - plan.totals.withoutSuccessor} {plan.totals.items - plan.totals.withoutSuccessor === 1 ? 'has' : 'have'} a suggested person.
                </p>
                <Button onClick={() => toggleMany(entries, approved.size < approvable.length)}>
                  {approved.size < approvable.length ? `Approve all suggestions (${approvable.length})` : 'Clear approvals'}
                </Button>
              </div>
              {plan.groups.map((g, gi) => {
                const ok = g.entries.filter((e) => choice[e.itemId]);
                const allOn = ok.length > 0 && ok.every((e) => approved.has(e.itemId));
                return (
                  <section key={g.area} className="card" style={{ overflow: 'hidden' }} aria-labelledby={`g${gi}`}>
                    <div className="group-head">
                      <h2 id={`g${gi}`}>{g.area}</h2>
                      <Checkbox label={`Approve all in ${g.area}`} isChecked={allOn} isDisabled={ok.length === 0} onChange={(ev) => toggleMany(g.entries, ev.currentTarget.checked)} />
                    </div>
                    <table className="list">
                      <caption className="sr-only">Items in {g.area} that need cover</caption>
                      <thead><tr><th scope="col">Item</th><th scope="col">Cover with</th><th scope="col">Why this person</th><th scope="col">Approve</th></tr></thead>
                      <tbody>
                        {g.entries.map((e) => {
                          const opts = optionsFor(e);
                          const cur = opts.find((o) => o.value === choice[e.itemId]);
                          return (
                            <tr key={e.itemId}>
                              <td data-label="Item">
                                <strong>{label(e)}</strong>{' '}
                                {e.dueDuringAbsence && <Lozenge appearance="moved">Due while away</Lozenge>}{' '}
                                {e.kind === 'page' && <Lozenge>Page</Lozenge>}
                                <div className="row small">
                                  <button type="button" className="linkbtn small" onClick={() => setWhy(e)}>Why is this flagged?<span className="sr-only"> {e.title}</span></button>
                                  {(() => { const u = host ? itemUrl(e.itemId, host.siteUrl) : null; return u ? <ExternalLink url={u} label={`Open ${e.kind === 'page' ? e.title : e.itemId} in ${e.kind === 'page' ? 'Confluence' : 'Jira'}, new tab`}>{e.kind === 'page' ? 'Open page' : 'Open in Jira'}</ExternalLink> : null; })()}
                                </div>
                              </td>
                              <td data-label="Cover with">
                                <div className="sel">
                                  <Select
                                    aria-label={`Cover person for ${e.title}`} menuPosition="fixed"
                                    placeholder="Choose someone" options={opts} value={cur ?? null}
                                    onChange={(o) => { const v = (o as Opt | null)?.value; if (v) setChoice((c) => ({ ...c, [e.itemId]: v })); }}
                                  />
                                </div>
                              </td>
                              <td data-label="Why this person">
                                {cur ? (cur.evidence?.[0] ?? 'No direct history on this work. Suggested from the people around it.') : <span className="subtle">No clear fit. Choose someone to approve.</span>}
                                {cur && (cur.evidence?.length ?? 0) > 1 && <ul className="evidence">{cur.evidence!.slice(1).map((x, i) => <li key={i}>{x}</li>)}</ul>}
                              </td>
                              <td data-label="Approve">
                                <Checkbox label="Approve" isChecked={approved.has(e.itemId) && !!choice[e.itemId]} isDisabled={!choice[e.itemId]}
                                  onChange={(ev) => toggle(e.itemId, ev.currentTarget.checked)} />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </section>
                );
              })}
              <div className="row-between card card-pad">
                <p aria-live="polite">{approvedEntries.length === 0 ? 'Nothing approved yet.' : `${plural(approvedEntries.length, 'change')} approved.`}</p>
                <PrimaryButton isDisabled={approvedEntries.length === 0} onClick={() => setPhase('preview')}>Preview changes</PrimaryButton>
              </div>
            </>
          ) : (
            <>
              <SectionMessage appearance={sample ? 'information' : 'warning'} title="Nothing changes until you apply">
                <p>{sample ? 'This is a sample site, so applying only previews the result. Nothing is written.' : 'These are the exact changes that will be made to your site.'}</p>
              </SectionMessage>
              <section className="card" aria-labelledby="pv">
                <div className="card-head"><h2 id="pv">{plural(approvedEntries.length, 'change')}</h2></div>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {approvedEntries.map((e) => (
                    <li key={e.itemId} className="card-pad" style={{ borderBottom: '1px solid var(--ds-border,#dcdfe4)' }}>
                      <strong>{label(e)}</strong>
                      <div className="subtle">Cover goes to {nameOf(choice[e.itemId]!)}.</div>
                    </li>
                  ))}
                </ul>
              </section>
              {applyErr != null && <ErrorPanel error={applyErr} onRetry={apply} what="the result of applying" unchanged={false} />}
              <div className="row">
                <PrimaryButton onClick={apply}>{sample ? 'Apply (sample only)' : `Apply ${plural(approvedEntries.length, 'change')}`}</PrimaryButton>
                <Button onClick={() => setPhase('review')}>Back to review</Button>
              </div>
            </>
          )}
        </>
      )}

      {phase === 'applying' && <Loading label={`Applying ${plural(approvedEntries.length, 'change')}. Don't close this page.`} rows={3} />}

      {plan && phase === 'done' && result && (
        <div className="stack">
          {result.skippedSample ? (
            <SectionMessage appearance="information" title="Preview only">
              <p>This is example data, so nothing was written to your site. On your own site, the {plural(approvedEntries.length, 'change')} you approved would be applied here.</p>
            </SectionMessage>
          ) : (
            <section className="card card-pad stack-sm" aria-labelledby="res" aria-live="polite">
              <h2 id="res">{result.failed.length === 0 ? 'All changes applied' : `${result.done.length} applied, ${result.failed.length} didn't go through`}</h2>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} className="stack-sm">
                {result.done.map((d) => <li key={d.operationKey}><Lozenge appearance="success">Done</Lozenge> {titleOf(entries, d.itemId)}</li>)}
                {result.failed.map((f) => (
                  <li key={f.operationKey}>
                    <Lozenge appearance="removed">Skipped</Lozenge> {titleOf(entries, f.itemId)}
                    <div className="subtle">{f.reason}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!result.skippedSample && (
            <section className="card card-pad stack-sm" aria-labelledby="rs">
              <h2 id="rs">Check the result</h2>
              {rescan ? (
                <div aria-live="polite" className="stack-sm">
                  <p className="big num">{plural(rescan.before, 'item')} at risk before, {plural(rescan.remainingAtRisk, 'item')} with nobody covering now</p>
                </div>
              ) : <p className="subtle">Re-scan to confirm how many items still have nobody covering them.</p>}
              {followErr != null && <ErrorPanel error={followErr} what="that" unchanged={false} />}
              <div className="row">
                <PrimaryButton onClick={doRescan} isDisabled={busy !== null}>{busy === 'rescan' ? 'Re-scanning' : rescan ? 'Re-scan again' : 'Re-scan'}</PrimaryButton>
                {result.done.length > 0 && (!undo || undo.failed.length > 0) && <Button onClick={doUndo} isDisabled={busy !== null}>{busy === 'undo' ? 'Undoing' : undo ? 'Undo again' : 'Undo this run'}</Button>}
              </div>
              {undo && (
                <SectionMessage appearance={undo.failed.length ? 'warning' : 'success'} title={undo.failed.length ? `Undid ${undo.reverted}, but ${undo.failed.length} could not be put back` : `Undone. ${plural(undo.reverted, 'item')} put back as before.`}>
                  {undo.failed.length > 0 && <ul style={{ margin: 0, paddingLeft: 20 }}>{undo.failed.map((f) => <li key={f.itemId}>{titleOf(entries, f.itemId)}: {f.reason}</li>)}</ul>}
                </SectionMessage>
              )}
            </section>
          )}
          <div className="row"><Button onClick={() => { setPhase('form'); setRes(null); }}>Plan another person</Button></div>
        </div>
      )}

      {why && plan && <Suspense fallback={null}><WhyDrawer entry={why} leaver={plan.leaverName} isOpen onClose={() => setWhy(null)} chosenName={nameOf(choice[why.itemId] ?? '')} /></Suspense>}
    </div>
  );
}

function titleOf(es: PlanEntry[], id: string) {
  const e = es.find((x) => x.itemId === id);
  return e ? label(e) : id;
}
