import {
  botIds,
  contributionTable,
  eligibleEdges,
  type ContributionTable,
  type DecayOptions,
} from './concentration';
import type { Edge, Graph, Item, Person } from './model';
import { KIND_ORDER, PHRASES } from './phrases';

export interface SuccessorOptions extends DecayOptions {
  /** How many to return. Default 3. */
  k?: number;
  /** Probability of jumping back to the seed each step. Default 0.15. */
  restart?: number;
  maxIter?: number;
  epsilon?: number;
  /** Score penalty per unit of load. Default 0.3. */
  loadWeight?: number;
  /** Score bonus for being on `team`. Default 0.1. */
  teamBonus?: number;
  team?: string;
  /** Person ids that must not be suggested (the leaver, people on leave). */
  exclude?: string[];
  /** Overrides Person.load; used by the planner to spread work. */
  loadOverrides?: Map<string, number>;
}

export interface PprResult {
  /** Node score by key: "p:<personId>" and "i:<itemId>". Sums to ~1. */
  scores: Map<string, number>;
  iterations: number;
  converged: boolean;
}

export interface Successor {
  personId: string;
  name: string;
  /** rel(ppr) - loadWeight*load + teamBonus*onTeam */
  score: number;
  /** Raw personalized PageRank mass */
  ppr: number;
  load: number;
  evidence: string[];
  /** True when every count behind this suggestion on the component is {@link THIN_EVIDENCE_MAX} or less. */
  thinEvidence: boolean;
}

/** At or below this many events per kind, a suggestion rests on little history. */
export const THIN_EVIDENCE_MAX = 2;

const pKey = (id: string) => `p:${id}`;
const iKey = (id: string) => `i:${id}`;

/** The person-item graph in flat arrays, built once and shared by every seed in a plan. */
interface PprGraph {
  keys: string[];
  index: Map<string, number>;
  off: Int32Array;
  to: Int32Array;
  w: Float64Array;
  outW: Float64Array;
}

function buildPprGraph(table: ContributionTable): PprGraph {
  const adj = new Map<string, Array<[string, number]>>();
  const link = (a: string, b: string, w: number) => {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, w]);
  };
  const itemIds = [...table.keys()].sort();
  for (const it of itemIds) {
    const row = table.get(it)!;
    for (const p of [...row.keys()].sort()) {
      const w = row.get(p)!;
      link(iKey(it), pKey(p), w);
      link(pKey(p), iKey(it), w);
    }
  }
  const keys = [...adj.keys()].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  const off = new Int32Array(keys.length + 1);
  let total = 0;
  keys.forEach((k, i) => {
    off[i] = total;
    total += adj.get(k)!.length;
  });
  off[keys.length] = total;
  const to = new Int32Array(total);
  const w = new Float64Array(total);
  const outW = new Float64Array(keys.length);
  keys.forEach((k, i) => {
    let o = off[i]!;
    let sum = 0;
    for (const [m, wt] of adj.get(k)!) {
      to[o] = index.get(m)!;
      w[o] = wt;
      o++;
      sum += wt;
    }
    outW[i] = sum;
  });
  return { keys, index, off, to, w, outW };
}

function runPpr(g: PprGraph, seedItemId: string, opts: SuccessorOptions): { rank: Float64Array; iterations: number; converged: boolean } {
  const restart = Math.min(0.99, Math.max(0.01, opts.restart ?? 0.15));
  const maxIter = opts.maxIter ?? 200;
  const eps = opts.epsilon ?? 1e-12;
  const n = g.keys.length;
  const seed = g.index.get(iKey(seedItemId));
  // A seed nobody touched has no edges: all mass stays on it and everyone else scores 0.
  if (seed === undefined) return { rank: new Float64Array(n), iterations: 1, converged: true };
  let rank = new Float64Array(n);
  let next = new Float64Array(n);
  rank[seed] = 1;
  let iterations = 0;
  let converged = false;
  for (let k = 0; k < maxIter; k++) {
    next.fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      const r = rank[i]!;
      if (r === 0) continue;
      const ow = g.outW[i]!;
      if (ow <= 0) {
        dangling += r;
        continue;
      }
      for (let e = g.off[i]!; e < g.off[i + 1]!; e++) {
        const t = g.to[e]!;
        next[t] = next[t]! + (1 - restart) * r * (g.w[e]! / ow);
      }
    }
    next[seed] = next[seed]! + restart + (1 - restart) * dangling;
    let delta = 0;
    for (let i = 0; i < n; i++) delta += Math.abs(next[i]! - rank[i]!);
    [rank, next] = [next, rank];
    iterations = k + 1;
    if (delta < eps) {
      converged = true;
      break;
    }
  }
  return { rank, iterations, converged };
}

/**
 * Personalized PageRank from one item over the undirected person-item graph, edge weights
 * being contribution weights (decayed only if halfLifeDays is set) (bots excluded). Dangling mass returns to the
 * seed, so total mass is conserved at 1.
 */
export function personalizedPageRank(
  graph: Graph,
  seedItemId: string,
  cutoff: number,
  opts: SuccessorOptions = {},
): PprResult {
  const g = buildPprGraph(contributionTable(graph, cutoff, opts));
  const { rank, iterations, converged } = runPpr(g, seedItemId, opts);
  const scores = new Map<string, number>(g.keys.map((k, i) => [k, rank[i]!]));
  if (!g.index.has(iKey(seedItemId))) scores.set(iKey(seedItemId), 1);
  return { scores, iterations, converged };
}

interface ScopeStats {
  total: Map<string, number>;
  mine: Map<string, Map<string, number>>;
}

/**
 * Everything that does not depend on the seed item, computed once. A plan ranks successors for hundreds of
 * items against the same graph; rebuilding these per item is what made large sites time out.
 */
export interface SuccessorIndex {
  ppr: PprGraph;
  edges: Edge[];
  botFree: Set<string>;
  bots: Set<string>;
  itemsById: Map<string, Item>;
  /** Items that point at an item through blocks or links. */
  pointedBy: Map<string, string[]>;
  /** Items whose goal is this item. */
  underGoal: Map<string, string[]>;
  itemsOf: Map<string, Set<string>>;
  edgesByItem: Map<string, Edge[]>;
  itemsByArea: Map<string, string[]>;
  stats: Map<string, ScopeStats>;
}

export function prepareSuccessors(graph: Graph, cutoff: number, opts: DecayOptions = {}): SuccessorIndex {
  const edges = eligibleEdges(graph, cutoff);
  const pointedBy = new Map<string, string[]>();
  const underGoal = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  for (const it of graph.items) {
    for (const o of it.blocks ?? []) push(pointedBy, o, it.id);
    for (const o of it.links ?? []) push(pointedBy, o, it.id);
    if (it.goal) push(underGoal, it.goal, it.id);
  }
  const itemsOf = new Map<string, Set<string>>();
  const edgesByItem = new Map<string, Edge[]>();
  for (const e of edges) {
    (itemsOf.get(e.person) ?? itemsOf.set(e.person, new Set()).get(e.person)!).add(e.item);
    push2(edgesByItem, e.item, e);
  }
  const itemsByArea = new Map<string, string[]>();
  for (const it of graph.items) if (it.area) push(itemsByArea, it.area, it.id);
  return {
    ppr: buildPprGraph(contributionTable(graph, cutoff, opts)),
    edges,
    botFree: new Set(edges.map((e) => e.person)),
    bots: botIds(graph),
    itemsById: new Map(graph.items.map((i) => [i.id, i])),
    pointedBy,
    underGoal,
    itemsOf,
    edgesByItem,
    itemsByArea,
    stats: new Map(),
  };
}

function push2<T>(m: Map<string, T[]>, k: string, v: T) {
  (m.get(k) ?? m.set(k, []).get(k)!).push(v);
}

/** Same set as scanning the whole graph for items that block, link to, or sit under `item`. */
function neighbourIds(item: Item, ix: SuccessorIndex): string[] {
  const out = new Set<string>([...(item.blocks ?? []), ...(item.links ?? []), ...(ix.pointedBy.get(item.id) ?? [])]);
  if (item.goal) out.add(item.goal);
  if (item.kind === 'goal') for (const id of ix.underGoal.get(item.id) ?? []) out.add(id);
  out.delete(item.id);
  return [...out].sort();
}

/** Event counts by kind over the seed's component (or the seed alone), plus each person's share of them. */
function scopeStats(ix: SuccessorIndex, seed: Item): ScopeStats {
  const key = seed.area ? `a:${seed.area}` : `i:${seed.id}`;
  const hit = ix.stats.get(key);
  if (hit) return hit;
  const ids = seed.area ? new Set([...(ix.itemsByArea.get(seed.area) ?? []), seed.id]) : new Set([seed.id]);
  const total = new Map<string, number>();
  const mine = new Map<string, Map<string, number>>();
  for (const id of ids) {
    for (const e of ix.edgesByItem.get(id) ?? []) {
      total.set(e.kind, (total.get(e.kind) ?? 0) + 1);
      const m = mine.get(e.person) ?? mine.set(e.person, new Map()).get(e.person)!;
      m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
    }
  }
  const st = { total, mine };
  ix.stats.set(key, st);
  return st;
}

/** Human-readable reasons this person is a fit for the item. */
function buildEvidence(
  ix: SuccessorIndex,
  seed: Item,
  person: Person,
  onTeam: boolean,
  team: string | undefined,
): { lines: string[]; thin: boolean } {
  const scope = seed.area ? 'on this component' : 'on this item';
  const stats = scopeStats(ix, seed);
  const mine = stats.mine.get(person.id) ?? new Map<string, number>();
  const lines: Array<{ ratio: number; n: number; text: string }> = [];
  for (const kind of KIND_ORDER) {
    const n = mine.get(kind) ?? 0;
    if (n === 0) continue;
    const m = stats.total.get(kind)!;
    const ph = PHRASES[kind];
    lines.push({ ratio: n / m, n, text: `${ph.did} ${n} of ${m} ${ph.evidenceNoun} ${scope}` });
  }
  lines.sort((a, b) => b.ratio - a.ratio || b.n - a.n);
  const out = lines.slice(0, 2).map((l) => l.text);

  const touched = ix.itemsOf.get(person.id);
  if (touched) {
    for (const nid of neighbourIds(seed, ix)) {
      if (touched.has(nid)) {
        out.push(`worked on "${ix.itemsById.get(nid)!.title}", which is connected to this item`);
        break;
      }
    }
  }
  if (onTeam && team) out.push(`on the ${team} team`);
  const thin = lines.every((l) => l.n <= THIN_EVIDENCE_MAX);
  return { lines: out, thin };
}

/**
 * Ranks people to take over `itemId`: personalized PageRank from the item (relevance), minus a load
 * penalty plus a small team prior. Deterministic: ties on score break by person id. Pass `index`
 * (from {@link prepareSuccessors}) when ranking many items against one graph.
 */
export function suggestSuccessors(
  graph: Graph,
  itemId: string,
  cutoff: number,
  opts: SuccessorOptions & { index?: SuccessorIndex } = {},
): Successor[] {
  const ix = opts.index ?? prepareSuccessors(graph, cutoff, opts);
  const seed = ix.itemsById.get(itemId);
  if (!seed) return [];
  const k = opts.k ?? 3;
  const loadWeight = opts.loadWeight ?? 0.3;
  const teamBonus = opts.teamBonus ?? 0.1;
  const exclude = new Set(opts.exclude ?? []);

  const { rank } = runPpr(ix.ppr, itemId, opts);
  const candidates = graph.people.filter(
    (p) => !exclude.has(p.id) && p.active !== false && !ix.bots.has(p.id) && (ix.botFree.has(p.id) || (opts.team && p.team === opts.team)),
  );
  const pprOf = (p: Person) => {
    const i = ix.ppr.index.get(pKey(p.id));
    return i === undefined ? 0 : rank[i]!;
  };
  const maxPpr = candidates.reduce((m, p) => Math.max(m, pprOf(p)), 0);

  const ranked = candidates.map((p): Successor => {
    const ppr = pprOf(p);
    const load = Math.min(1, Math.max(0, opts.loadOverrides?.get(p.id) ?? p.load ?? 0));
    const onTeam = !!opts.team && p.team === opts.team;
    const rel = maxPpr > 0 ? ppr / maxPpr : 0;
    const score = rel - loadWeight * load + (onTeam ? teamBonus : 0);
    const ev = buildEvidence(ix, seed, p, onTeam, opts.team);
    return { personId: p.id, name: p.name, score, ppr, load, evidence: ev.lines, thinEvidence: ev.thin };
  });

  return ranked
    .filter((s) => s.ppr > 0 || s.evidence.length > 0)
    .sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1))
    .slice(0, k);
}
