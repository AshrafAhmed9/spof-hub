import {
  concentrationOf,
  contributionTable,
  type DecayOptions,
} from './concentration';
import { DAY_MS, type Graph, type Item, type Priority } from './model';

export interface RiskOptions extends DecayOptions {
  /** Fraction of a neighbour's risk that passes on. 0..1, default 0.4. */
  damping?: number;
  /** Hard cap on propagation rounds. Default 20. */
  maxIter?: number;
  /** Stop when the largest change in a round is below this. Default 1e-9. */
  epsilon?: number;
}

export interface Exposure {
  priority: number;
  due: number;
  open: number;
  /** open * (0.6 * priority + 0.4 * due), in [0, 1] */
  value: number;
}

export interface RiskScore {
  itemId: string;
  concentration: number;
  exposure: Exposure;
  /** concentration x exposure.value */
  own: number;
  /** total - own: what arrived from neighbours */
  inherited: number;
  /** Final risk after propagation, in [0, 1] */
  total: number;
  /** Neighbour that contributed the most inherited risk, if any */
  via?: string;
  iterations: number;
}

const PRIORITY_WEIGHT: Record<Priority, number> = {
  highest: 1,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
  lowest: 0.1,
};

const DUE_HORIZON_DAYS = 60;

export function exposure(item: Item, now: number): Exposure {
  const open = item.open ? 1 : 0;
  const priority = item.priority ? PRIORITY_WEIGHT[item.priority] : 0.5;
  let due = 0.3; // no due date: mild pressure
  if (item.dueAt !== undefined && Number.isFinite(item.dueAt)) {
    const days = (item.dueAt - now) / DAY_MS;
    if (days <= 0) due = 1;
    else if (days >= DUE_HORIZON_DAYS) due = 0.2;
    else due = 1 - 0.8 * (days / DUE_HORIZON_DAYS);
  }
  return { priority, due, open, value: open * (0.6 * priority + 0.4 * due) };
}

/** Directed risk-flow edges: blocker -> blocked, linked <-> linked, item -> parent goal. */
export function riskFlows(graph: Graph): Map<string, string[]> {
  const ids = new Set(graph.items.map((i) => i.id));
  const inflow = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (from === to || !ids.has(from) || !ids.has(to)) return;
    let s = inflow.get(to);
    if (!s) inflow.set(to, (s = new Set()));
    s.add(from);
  };
  for (const it of graph.items) {
    for (const b of it.blocks ?? []) add(it.id, b);
    for (const l of it.links ?? []) {
      add(it.id, l);
      add(l, it.id);
    }
    if (it.goal) add(it.id, it.goal);
  }
  const out = new Map<string, string[]>();
  for (const [to, s] of inflow) out.set(to, [...s].sort());
  return out;
}

/**
 * Risk of losing `personId` for every item. Own risk = concentration x exposure. Neighbour
 * risk is folded in with a noisy-OR, total_i = 1 - (1 - own_i) * prod_j (1 - d * total_j),
 * run synchronously in sorted id order for at most maxIter rounds. Every term stays in
 * [0, 1] and the update is monotone, so it is bounded, cycle-safe and deterministic.
 * Returned sorted by total desc, then id.
 */
export function propagateRisk(
  graph: Graph,
  personId: string,
  cutoff: number,
  now: number,
  opts: RiskOptions = {},
): RiskScore[] {
  const d = Math.min(1, Math.max(0, opts.damping ?? 0.4));
  const maxIter = Math.max(0, Math.floor(opts.maxIter ?? 20));
  const eps = opts.epsilon ?? 1e-9;

  const table = contributionTable(graph, cutoff, opts);
  const items = [...graph.items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const inflow = riskFlows(graph);

  const conc = new Map<string, number>();
  const expo = new Map<string, Exposure>();
  const own = new Map<string, number>();
  for (const it of items) {
    const c = concentrationOf(table, it.id, personId);
    const e = exposure(it, now);
    conc.set(it.id, c);
    expo.set(it.id, e);
    own.set(it.id, c * e.value);
  }

  let cur = new Map(own);
  let iterations = 0;
  for (let k = 0; k < maxIter; k++) {
    const next = new Map<string, number>();
    let delta = 0;
    for (const it of items) {
      let keep = 1 - own.get(it.id)!;
      for (const j of inflow.get(it.id) ?? []) keep *= 1 - d * cur.get(j)!;
      const v = Math.min(1, Math.max(0, 1 - keep));
      next.set(it.id, v);
      delta = Math.max(delta, Math.abs(v - cur.get(it.id)!));
    }
    cur = next;
    iterations = k + 1;
    if (delta < eps) break;
  }

  const scores = items.map((it): RiskScore => {
    const total = cur.get(it.id)!;
    const o = own.get(it.id)!;
    let via: string | undefined;
    let best = 0;
    for (const j of inflow.get(it.id) ?? []) {
      const c = d * cur.get(j)!;
      if (c > best + 1e-12) {
        best = c;
        via = j;
      }
    }
    const score: RiskScore = {
      itemId: it.id,
      concentration: conc.get(it.id)!,
      exposure: expo.get(it.id)!,
      own: o,
      inherited: Math.max(0, total - o),
      total,
      iterations,
    };
    if (via !== undefined) score.via = via;
    return score;
  });
  return scores.sort((a, b) => b.total - a.total || (a.itemId < b.itemId ? -1 : 1));
}
