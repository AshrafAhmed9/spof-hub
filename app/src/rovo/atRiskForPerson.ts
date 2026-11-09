import { buildHandoverPlan } from '../engine';
import type { Deps } from '../service';
import { MAX_ROWS, compactEntry, graphOrError, pick, str, absence, type RovoPayload } from './common';

/** Rovo action at_risk_for_person: what is exposed if this person is away. */
export async function run(deps: Deps, p: RovoPayload) {
  const who = str(p.person);
  if (!who) return { error: 'Which person? Give a name.', notes: [] as string[] };
  const g = await graphOrError(deps);
  const found = pick(g.graph, who);
  if (!found.person) return { error: found.error, notes: g.notes };
  const w = absence(p, g.now);
  const plan = buildHandoverPlan(g.graph, { leaverId: found.person.id, from: w.from, to: w.to });
  const entries = plan.groups.flatMap((x) => x.entries).sort((a, b) => b.risk - a.risk);
  return {
    notes: [...g.notes, ...w.notes],
    complete: !g.partial,
    person: found.person.name,
    window: { from: new Date(w.from).toISOString().slice(0, 10), to: new Date(w.to).toISOString().slice(0, 10) },
    atRiskCount: plan.totals.items,
    withoutSuccessor: plan.totals.withoutSuccessor,
    shown: Math.min(MAX_ROWS, entries.length),
    items: entries.slice(0, MAX_ROWS).map(compactEntry),
  };
}
