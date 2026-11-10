import { DAY_MS, suggestSuccessors, type Graph, type PlanEntry } from '../engine';
import { findPerson, loadGraph, type Deps, type LoadedGraph } from '../service';
import { round } from '../analysis';

/** Rovo passes the model's inputs at the top level plus `context` (accountId, cloudId, ...). */
export interface RovoPayload { context?: { accountId?: string; cloudId?: string }; [k: string]: unknown }

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Each action must stay far below Rovo's ~20 s and ~1 MB limits. */
export const MAX_ROWS = 30;

export function absence(p: RovoPayload, now: number): { from: number; to: number; notes: string[] } {
  const notes: string[] = [];
  const parse = (v: unknown) => {
    const t = Date.parse(str(v));
    return Number.isFinite(t) ? t : NaN;
  };
  let from = parse(p.from);
  let to = parse(p.to);
  if (!Number.isFinite(from)) {
    from = now;
    if (str(p.from)) notes.push(`Could not read the start date "${str(p.from)}"; used today.`);
  }
  if (!Number.isFinite(to) || to < from) {
    to = from + 14 * DAY_MS;
    notes.push('No valid end date given; assumed a 14-day absence.');
  }
  return { from, to, notes };
}

export async function graphOrError(deps: Deps): Promise<LoadedGraph> {
  const g = await loadGraph(deps, 'live');
  // Logged so a call from an outside client can be diagnosed: an empty result and a hidden one look the same to the caller.
  console.log('action graph', JSON.stringify({ items: g.graph.items.length, people: g.graph.people.length, partial: g.partial, notes: g.notes.slice(0, 3), viewer: deps.viewerId ? 'set' : 'none' }));
  return g;
}

export function pick(g: Graph, who: string) {
  return findPerson(g, who);
}

export function compactEntry(e: PlanEntry) {
  return {
    item: e.itemId,
    title: e.title.slice(0, 120),
    risk: round(e.risk),
    holds: round(e.concentration),
    dueDuringAbsence: e.dueDuringAbsence,
    why: e.reasons.slice(0, 4),
    suggested: e.successor ? { id: e.successor.personId, name: e.successor.name, because: e.successor.evidence.slice(0, 3) } : null,
  };
}

export { suggestSuccessors };
