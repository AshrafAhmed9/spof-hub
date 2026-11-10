import { DAY_MS, type Graph, type Item } from './model';
import { explainRisk, type RiskBreakdown } from './explain';
import { assignWithCapacity } from './assign';
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
  /**
   * Most items one person may receive. When set, the whole plan is solved at once (minimum-cost flow)
   * so nobody exceeds the limit and total fit is the best possible. Unset: items are picked one by one
   * with a growing load penalty.
   */
  maxPerPerson?: number;
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
  // A limit changes who gets what, so it is part of the key; plans without one keep their earlier keys.
  const capKey = opts.maxPerPerson !== undefined && opts.maxPerPerson > 0 ? `|cap${opts.maxPerPerson}` : '';
  const planKey = `plan_${stableKey(`${req.leaverId}|${req.from}|${req.to}${capKey}`)}`;

  const items = new Map(graph.items.map((i) => [i.id, i]));
  const risks = propagateRisk(graph, req.leaverId, req.from, req.from, opts).filter((r) => {
    const it = items.get(r.itemId)!;
    return it.kind !== 'goal' && it.open && r.concentration > 0 && r.total >= minRisk;
  }); // already sorted by risk desc, id asc

  const loads = new Map<string, number>();
  const entries: PlanEntry[] = [];
  const { eligible, ...succOpts } = opts;
  const cap = opts.maxPerPerson;
  const rank = (itemId: string, k: number, loadOverrides: Map<string, number>) =>
    suggestSuccessors(graph, itemId, req.from, {
      ...succOpts,
      k,
      exclude: [req.leaverId, ...(opts.exclude ?? [])],
      loadOverrides,
      ...(leaver?.team !== undefined ? { team: leaver.team } : {}),
    }).filter((c) => !eligible || eligible(itemId, c.personId));

  // Capped mode: rank everyone first, then choose all successors together.
  let chosen: Array<string | null> | undefined;
  let pools: Successor[][] | undefined;
  if (cap !== undefined && cap > 0) {
    pools = risks.map((r) => rank(r.itemId, Math.max(12, 1 + nAlt + 8), new Map()));
    chosen = assignWithCapacity(pools.map((l) => l.map((c) => ({ personId: c.personId, score: c.score }))), () => cap);
  }

  for (let idx = 0; idx < risks.length; idx++) {
    const r = risks[idx]!;
    const it = items.get(r.itemId)!;
    let successor: Successor | null;
    let alternates: Successor[];
    if (pools && chosen) {
      const pick = chosen[idx];
      const pool = pools[idx]!;
      successor = pick ? (pool.find((c) => c.personId === pick) ?? null) : null;
      alternates = pool.filter((c) => c.personId !== pick).slice(0, nAlt);
    } else {
      // Ask for extra so ineligible people can be dropped without leaving the item empty.
      const ranked = rank(it.id, eligible ? 1 + nAlt + 8 : 1 + nAlt, loads).slice(0, 1 + nAlt);
      successor = ranked[0] ?? null;
      alternates = ranked.slice(1);
      if (successor) loads.set(successor.personId, Math.min(1, successor.load + loadStep));
    }

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
      alternates,
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
