import { DAY_MS, type Graph, type Item } from './model';
import { explainRisk, type RiskBreakdown } from './explain';
import { propagateRisk, type RiskOptions } from './propagation';
import { suggestSuccessors, type Successor, type SuccessorOptions } from './successor';

export interface PlanRequest {
  leaverId: string;
  /** Start of the absence (ms). Knowledge is measured as of this date. */
  from: number;
  /** End of the absence (ms). */
  to: number;
}

export interface PlanOptions extends RiskOptions, Omit<SuccessorOptions, 'k' | 'exclude' | 'loadOverrides' | 'team'> {
  /** Return false when this person cannot take this item (for example, not assignable in its project). */
  eligible?: (itemId: string, personId: string) => boolean;
  /** Ignore items below this total risk. Default 0.15. */
  minRisk?: number;
  /** Alternates per item besides the pick. Default 2. */
  alternates?: number;
  /** Load added to a successor each time they are picked. Default 0.05. */
  loadStep?: number;
  /** People who must not receive work (besides the leaver and inactive people). */
  exclude?: string[];
}

export interface PlanEntry {
  itemId: string;
  title: string;
  kind: Item['kind'];
  risk: number;
  concentration: number;
  /** Due date falls inside the absence window. */
  dueDuringAbsence: boolean;
  reasons: string[];
  breakdown: RiskBreakdown;
  successor: Successor | null;
  alternates: Successor[];
  /** Stable key for later writes; same plan inputs and choice give the same key. */
  operationKey: string;
}

export interface PlanGroup {
  area: string;
  maxRisk: number;
  entries: PlanEntry[];
}

export interface HandoverPlan {
  planKey: string;
  leaverId: string;
  leaverName: string;
  from: number;
  to: number;
  groups: PlanGroup[];
  totals: { items: number; withoutSuccessor: number };
}

/** Two FNV-1a passes with different offsets, 16 hex chars. Not cryptographic. */
export function stableKey(input: string): string {
  const run = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return run(0x811c9dc5) + run(0x9747b28c);
}

export function buildHandoverPlan(graph: Graph, req: PlanRequest, opts: PlanOptions = {}): HandoverPlan {
  const leaver = graph.people.find((p) => p.id === req.leaverId);
  const leaverName = leaver?.name ?? req.leaverId;
  const minRisk = opts.minRisk ?? 0.15;
  const nAlt = opts.alternates ?? 2;
  const loadStep = opts.loadStep ?? 0.05;
  const planKey = `plan_${stableKey(`${req.leaverId}|${req.from}|${req.to}`)}`;

  const items = new Map(graph.items.map((i) => [i.id, i]));
  const risks = propagateRisk(graph, req.leaverId, req.from, req.from, opts).filter((r) => {
    const it = items.get(r.itemId)!;
    return it.kind !== 'goal' && it.open && r.concentration > 0 && r.total >= minRisk;
  }); // already sorted by risk desc, id asc

  const loads = new Map<string, number>();
  const entries: PlanEntry[] = [];
  for (const r of risks) {
    const it = items.get(r.itemId)!;
    const { eligible, ...succOpts } = opts;
    const ranked = suggestSuccessors(graph, it.id, req.from, {
      ...succOpts,
      // Ask for extra so ineligible people can be dropped without leaving the item empty.
      k: eligible ? 1 + nAlt + 8 : 1 + nAlt,
      exclude: [req.leaverId, ...(opts.exclude ?? [])],
      loadOverrides: loads,
      ...(leaver?.team !== undefined ? { team: leaver.team } : {}),
    }).filter((c) => !eligible || eligible(it.id, c.personId)).slice(0, 1 + nAlt);
    const successor = ranked[0] ?? null;
    if (successor) loads.set(successor.personId, Math.min(1, successor.load + loadStep));

    const ex = explainRisk(graph, r, req.leaverId, req.from);
    entries.push({
      itemId: it.id,
      title: it.title,
      kind: it.kind,
      risk: r.total,
      concentration: r.concentration,
      dueDuringAbsence: it.dueAt !== undefined && it.dueAt >= req.from && it.dueAt <= req.to + DAY_MS - 1,
      reasons: ex.reasons,
      breakdown: ex.breakdown,
      successor,
      alternates: ranked.slice(1),
      operationKey: `op_${stableKey(`${planKey}|${it.id}|${successor?.personId ?? 'none'}`)}`,
    });
  }

  const byArea = new Map<string, PlanEntry[]>();
  for (const e of entries) {
    const area = items.get(e.itemId)!.area ?? 'No area';
    (byArea.get(area) ?? byArea.set(area, []).get(area)!).push(e);
  }
  const groups: PlanGroup[] = [...byArea.entries()]
    .map(([area, es]) => ({ area, maxRisk: Math.max(...es.map((e) => e.risk)), entries: es }))
    .sort((a, b) => b.maxRisk - a.maxRisk || (a.area < b.area ? -1 : 1));

  return {
    planKey,
    leaverId: req.leaverId,
    leaverName,
    from: req.from,
    to: req.to,
    groups,
    totals: { items: entries.length, withoutSuccessor: entries.filter((e) => !e.successor).length },
  };
}
