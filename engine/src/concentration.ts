import { isBot } from './botFilter';
import { DAY_MS, type Edge, type Graph, type Item } from './model';

/**
 * Decay is off by default (Infinity = no decay). The backtest (backtest/RESULTS.md) found a
 * time-decayed share no better than the plain share. Pass halfLifeDays to turn it on.
 */
export const DEFAULT_HALF_LIFE_DAYS = Infinity;

export interface DecayOptions {
  /** Half-life of a contribution in days. Default: none (plain, undecayed share). */
  halfLifeDays?: number;
}

/** itemId -> personId -> weight (decayed only if halfLifeDays is set) */
export type ContributionTable = Map<string, Map<string, number>>;

export function decayFactor(ageMs: number, halfLifeDays: number): number {
  if (ageMs <= 0) return 1;
  const hl = halfLifeDays > 0 ? halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
  if (!Number.isFinite(hl)) return 1;
  return Math.pow(0.5, ageMs / (hl * DAY_MS));
}

/** Ids of people who are bots, by explicit flag or by name. Unknown ids are tested by id. */
export function botIds(graph: Graph): Set<string> {
  const out = new Set<string>();
  const known = new Set<string>();
  for (const p of graph.people) {
    known.add(p.id);
    if (p.isBot || isBot(p.name)) out.add(p.id);
  }
  for (const e of graph.edges) {
    if (!known.has(e.person) && isBot(e.person)) out.add(e.person);
  }
  return out;
}

/** Edges that count as knowledge: human, at or before the cutoff, positive finite weight. */
export function eligibleEdges(graph: Graph, cutoff: number): Edge[] {
  const bots = botIds(graph);
  return graph.edges.filter(
    (e) =>
      e.at <= cutoff &&
      Number.isFinite(e.weight) &&
      e.weight > 0 &&
      Number.isFinite(e.at) &&
      !bots.has(e.person),
  );
}

export function contributionTable(
  graph: Graph,
  cutoff: number,
  opts: DecayOptions = {},
): ContributionTable {
  const hl = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const table: ContributionTable = new Map();
  for (const e of eligibleEdges(graph, cutoff)) {
    const w = e.weight * decayFactor(cutoff - e.at, hl);
    let row = table.get(e.item);
    if (!row) table.set(e.item, (row = new Map()));
    row.set(e.person, (row.get(e.person) ?? 0) + w);
  }
  return table;
}

export function totalWeight(table: ContributionTable, itemId: string): number {
  let t = 0;
  for (const w of table.get(itemId)?.values() ?? []) t += w;
  return t;
}

/** Person's share of the item's contribution weight, in [0, 1]. 0 if nobody contributed. */
export function concentrationOf(table: ContributionTable, itemId: string, personId: string): number {
  const row = table.get(itemId);
  if (!row) return 0;
  const total = totalWeight(table, itemId);
  if (total <= 0) return 0;
  const share = (row.get(personId) ?? 0) / total;
  return Math.min(1, Math.max(0, share));
}

/** Convenience wrapper that builds the table each call. Use contributionTable for bulk work. */
export function itemConcentration(
  graph: Graph,
  itemId: string,
  personId: string,
  cutoff: number,
  opts: DecayOptions = {},
): number {
  return concentrationOf(contributionTable(graph, cutoff, opts), itemId, personId);
}

export interface TruckFactorOptions extends DecayOptions {
  /** A person only "knows" an item if their share is above this. Default 0 (any contribution). */
  minShare?: number;
}

export interface TruckFactorResult {
  truckFactor: number;
  /** People removed, in greedy order. */
  removed: string[];
  /** Work items with at least one contributor; the denominator. */
  considered: number;
  /** Share of considered items left with no remaining knowledgeable person after removal. */
  orphanedShare: number;
}

/**
 * Greedy Avelino-style truck factor over the work items in `items`: repeatedly remove the
 * person who knows the most still-covered items until more than half of the items have no
 * knowledgeable person left. Items nobody contributed to are ignored (nothing to lose).
 * Ties break on person id so the result is deterministic.
 */
export function areaTruckFactor(
  graph: Graph,
  items: Array<Item | string>,
  cutoff: number,
  opts: TruckFactorOptions = {},
): TruckFactorResult {
  const minShare = opts.minShare ?? 0;
  const table = contributionTable(graph, cutoff, opts);
  const kindById = new Map(graph.items.map((i) => [i.id, i.kind]));

  const knowers: Set<string>[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const id = typeof it === 'string' ? it : it.id;
    const kind = typeof it === 'string' ? kindById.get(it) : it.kind;
    if (kind !== 'workItem' || seen.has(id)) continue;
    seen.add(id);
    const total = totalWeight(table, id);
    if (total <= 0) continue;
    const set = new Set<string>();
    for (const [p, w] of table.get(id) ?? []) if (w / total > minShare) set.add(p);
    if (set.size > 0) knowers.push(set);
  }

  const n = knowers.length;
  if (n === 0) return { truckFactor: 0, removed: [], considered: 0, orphanedShare: 0 };

  const removed = new Set<string>();
  const order: string[] = [];
  const orphaned = () => knowers.filter((s) => [...s].every((p) => removed.has(p))).length;

  while (orphaned() * 2 <= n) {
    const counts = new Map<string, number>();
    for (const s of knowers) {
      if ([...s].every((p) => removed.has(p))) continue;
      for (const p of s) if (!removed.has(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    if (counts.size === 0) break;
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
    removed.add(best[0]);
    order.push(best[0]);
  }
  return {
    truckFactor: order.length,
    removed: order,
    considered: n,
    orphanedShare: orphaned() / n,
  };
}
