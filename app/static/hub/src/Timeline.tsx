import { useCallback, useEffect, useMemo, useState } from 'react';
import Select from '@atlaskit/select';
import { api, type Person } from './api';
import type { Mode, TimelineResponse } from '../../../shared/contract';
import WarningIcon from '@atlaskit/icon/core/status-warning';
import { EmptyState, ErrorPanel, Loading, PartialNotice, PrimaryButton, useFocusHeading } from './common';
import { DAY, fmtDate, fromInputDate, plural, shortName, todayDay, toInputDate } from './util';

type Away = { personId: string; name: string; from: number; to: number };

/** Who is away, week by week, and which areas then have nobody left who knows an item. */
export function Timeline({ mode, onSetup }: { mode: Mode; onSetup: () => void }) {
  const today = useMemo(() => todayDay(), []);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [aways, setAways] = useState<Away[]>([]);
  const [who, setWho] = useState('');
  const [from, setFrom] = useState(toInputDate(today + 7 * DAY));
  const [to, setTo] = useState(toInputDate(today + 13 * DAY));
  const [res, setRes] = useState<TimelineResponse | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ step: number; area: string } | null>(null);
  const h = useFocusHeading(mode);

  useEffect(() => { api.listPeople().then(setPeople, setErr); }, []);

  const run = useCallback((list: Away[]) => {
    if (list.length === 0) { setRes(null); return; }
    setBusy(true); setErr(null);
    api.getTimeline({ absences: list.map(({ personId, from: f, to: t }) => ({ personId, from: f, to: t })), start: today, weeks: 8 })
      .then((r) => { setRes(r); setBusy(false); }, (e) => { setErr(e); setBusy(false); });
  }, [today]);

  const bad = !who || !from || !to || fromInputDate(to) < fromInputDate(from);
  const add = () => {
    const p = people?.find((x) => x.id === who);
    if (!p || bad) return;
    const next = [...aways, { personId: who, name: p.name, from: fromInputDate(from), to: fromInputDate(to) }];
    setAways(next); setWho(''); setOpen(null); run(next);
  };
  const remove = (i: number) => { const next = aways.filter((_, k) => k !== i); setAways(next); setOpen(null); run(next); };

  const rows = useMemo(() => {
    if (!res) return [];
    const areas = new Map<string, number>();
    for (const s of res.steps) for (const a of s.areas) areas.set(a.area, Math.max(areas.get(a.area) ?? 0, a.uncovered));
    return [...areas.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([area]) => area);
  }, [res]);
  const total = res?.steps.reduce((n, s) => n + s.uncovered, 0) ?? 0;
  const detail = open && res ? res.steps[open.step]?.areas.find((a) => a.area === open.area) : undefined;

  return (
    <div className="stack">
      <div>
        <h1 ref={h} tabIndex={-1}>Who is away</h1>
        <p className="subtle">Add upcoming leave. Each week shows the areas where an item has nobody left who knows it.</p>
      </div>
      <form className="card card-pad stack-sm" onSubmit={(e) => { e.preventDefault(); add(); }} aria-label="Add leave">
        <div className="filters">
          <div className="field" style={{ minWidth: 240, flex: '1 1 240px' }}>
            <label htmlFor="tl-who">Who</label>
            <Select
              inputId="tl-who" menuPosition="fixed" placeholder={people ? 'Choose a person' : 'Loading people'} isLoading={!people && !err}
              options={(people ?? []).map((p) => ({ value: p.id, label: p.team ? `${p.name} (${p.team})` : p.name }))}
              value={who && people ? { value: who, label: people.find((p) => p.id === who)?.name ?? who } : null}
              onChange={(o) => setWho((o as { value: string } | null)?.value ?? '')}
            />
          </div>
          <div className="field"><label htmlFor="tl-from">Away from</label><input id="tl-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label htmlFor="tl-to">Back after</label><input id="tl-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></div>
        </div>
        <div className="row"><PrimaryButton type="submit" isDisabled={bad || busy}>Add leave</PrimaryButton></div>
      </form>

      {aways.length > 0 && (
        <ul className="chips" aria-label="Leave added">
          {aways.map((a, i) => (
            <li key={`${a.personId}${a.from}`} className="chip">
              {a.name}, {fmtDate(a.from)} to {fmtDate(a.to)}{' '}
              <button type="button" className="linklike" onClick={() => remove(i)} aria-label={`Remove leave for ${a.name}`}>Remove</button>
            </li>
          ))}
        </ul>
      )}

      {err != null && <ErrorPanel error={err} onRetry={() => run(aways)} what="the timeline" />}
      {busy && <Loading label="Checking each week" rows={3} />}
      {!busy && !res && err == null && aways.length === 0 && (
        <EmptyState title="No leave added yet" body="Add the first person who will be away and the weeks that follow will fill in." />
      )}
      {res && !busy && (
        <>
          {res.partial && <PartialNotice notes={res.notes} onSetup={onSetup} />}
          <p aria-live="polite">
            {total === 0
              ? 'In the next 8 weeks nobody present is left without someone who knows an item. Nothing here is uncovered.'
              : <>Across the next 8 weeks, {plural(total, 'item-week')} {total === 1 ? 'has' : 'have'} nobody left who knows {total === 1 ? 'it' : 'them'}.</>}
          </p>
          {rows.length > 0 && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table className="grid">
                <caption className="sr-only">Items with nobody left who knows them, by area and week</caption>
                <thead>
                  <tr>
                    <th scope="col">Area</th>
                    {res.steps.map((s) => (
                      <th scope="col" key={s.start}>
                        {fmtDate(s.start)}
                        {s.absent.length > 0 && <span className="subtle block">{s.absent.map((p) => shortName(p.name)).join(', ')} away</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((area) => (
                    <tr key={area}>
                      <th scope="row">{area}</th>
                      {res.steps.map((s, i) => {
                        const n = s.areas.find((a) => a.area === area)?.uncovered ?? 0;
                        return (
                          <td key={s.start} className={n > 0 ? 'hot' : ''}>
                            {n > 0 ? (
                              <button type="button" className="linklike" aria-expanded={open?.step === i && open.area === area} onClick={() => setOpen(open?.step === i && open.area === area ? null : { step: i, area })}>
                                <WarningIcon label="" />{n}<span className="sr-only"> {n === 1 ? 'item' : 'items'} in {area}, week of {fmtDate(s.start)}</span>
                              </button>
                            ) : <span aria-hidden="true">·</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {detail && open && res && (
            <section className="card card-pad stack-sm" aria-label={`Items in ${open.area}`}>
              <p><strong>{open.area}</strong>, week of {fmtDate(res.steps[open.step]!.start)}</p>
              <ul>{detail.items.map((it) => <li key={it.id}>{it.id === it.title ? it.title : `${it.id} ${it.title}`}</li>)}</ul>
            </section>
          )}
          <p className="subtle">An item counts when someone who is away holds at least half of what is known about it and everyone else together holds under a fifth. It needs at least three recorded contributions.</p>
        </>
      )}
    </div>
  );
}
