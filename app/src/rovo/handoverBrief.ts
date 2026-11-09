import { buildHandoverPlan } from '../engine';
import type { Deps } from '../service';
import { MAX_ROWS, compactEntry, graphOrError, pick, str, absence, type RovoPayload } from './common';

/** Rovo action handover_brief: the plan grouped by area, as data the agent turns into a brief. Read only. */
export async function run(deps: Deps, p: RovoPayload) {
  const who = str(p.person);
  if (!who) return { error: 'Whose handover? Give a name.', notes: [] as string[] };
  const g = await graphOrError(deps);
  const found = pick(g.graph, who);
  if (!found.person) return { error: found.error, notes: g.notes };
  const w = absence(p, g.now);
  const plan = buildHandoverPlan(g.graph, { leaverId: found.person.id, from: w.from, to: w.to });
  let budget = MAX_ROWS;
  const areas = plan.groups.map((grp) => {
    const take = grp.entries.slice(0, Math.max(0, budget));
    budget -= take.length;
    return { area: grp.area, maxRisk: Math.round(grp.maxRisk * 100) / 100, items: take.map(compactEntry), omitted: grp.entries.length - take.length };
  }).filter((a) => a.items.length > 0 || a.omitted > 0);
  return {
    notes: [...g.notes, ...w.notes],
    complete: !g.partial,
    person: found.person.name,
    window: { from: new Date(w.from).toISOString().slice(0, 10), to: new Date(w.to).toISOString().slice(0, 10) },
    totals: plan.totals,
    areas,
    limits: 'This brief is read only. Nothing was reassigned. Apply the plan from the Handover hub after review.',
  };
}
