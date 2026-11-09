import {
  botIds,
  contributionTable,
  eligibleEdges,
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
}

const pKey = (id: string) => `p:${id}`;
const iKey = (id: string) => `i:${id}`;

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
  const restart = Math.min(0.99, Math.max(0.01, opts.restart ?? 0.15));
  const maxIter = opts.maxIter ?? 200;
  const eps = opts.epsilon ?? 1e-12;

  const table = contributionTable(graph, cutoff, opts);
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
  const seed = iKey(seedItemId);
  if (!adj.has(seed)) adj.set(seed, []);
  const nodes = [...adj.keys()].sort();
  const outW = new Map<string, number>();
  for (const n of nodes) outW.set(n, adj.get(n)!.reduce((s, [, w]) => s + w, 0));

  let rank = new Map<string, number>(nodes.map((n) => [n, n === seed ? 1 : 0]));
  let iterations = 0;
  let converged = false;
  for (let k = 0; k < maxIter; k++) {
    const next = new Map<string, number>(nodes.map((n) => [n, 0]));
    let dangling = 0;
    for (const n of nodes) {
      const r = rank.get(n)!;
      const ow = outW.get(n)!;
      if (ow <= 0) {
        dangling += r;
        continue;
      }
      for (const [m, w] of adj.get(n)!) next.set(m, next.get(m)! + (1 - restart) * r * (w / ow));
    }
    next.set(seed, next.get(seed)! + restart + (1 - restart) * dangling);
    let delta = 0;
    for (const n of nodes) delta += Math.abs(next.get(n)! - rank.get(n)!);
    rank = next;
    iterations = k + 1;
    if (delta < eps) {
      converged = true;
      break;
    }
  }
  return { scores: rank, iterations, converged };
}

function neighbourIds(item: Item, graph: Graph): string[] {
  const out = new Set<string>([...(item.blocks ?? []), ...(item.links ?? [])]);
  if (item.goal) out.add(item.goal);
  for (const o of graph.items) {
    if (o.blocks?.includes(item.id) || o.links?.includes(item.id)) out.add(o.id);
    if (item.kind === 'goal' && o.goal === item.id) out.add(o.id);
  }
  out.delete(item.id);
  return [...out].sort();
}

/** Human-readable reasons this person is a fit for the item. */
function buildEvidence(
  graph: Graph,
  edges: Edge[],
  seed: Item,
  person: Person,
  onTeam: boolean,
  team: string | undefined,
): string[] {
  const areaIds = new Set(
    seed.area ? graph.items.filter((i) => i.area === seed.area).map((i) => i.id) : [seed.id],
  );
  areaIds.add(seed.id);
  const scope = seed.area ? 'on this component' : 'on this item';
  const total = new Map<string, number>();
  const mine = new Map<string, number>();
  for (const e of edges) {
    if (!areaIds.has(e.item)) continue;
    total.set(e.kind, (total.get(e.kind) ?? 0) + 1);
    if (e.person === person.id) mine.set(e.kind, (mine.get(e.kind) ?? 0) + 1);
  }
  const lines: Array<{ ratio: number; n: number; text: string }> = [];
  for (const kind of KIND_ORDER) {
    const n = mine.get(kind) ?? 0;
    if (n === 0) continue;
    const m = total.get(kind)!;
    const ph = PHRASES[kind];
    lines.push({ ratio: n / m, n, text: `${ph.did} ${n} of ${m} ${ph.evidenceNoun} ${scope}` });
  }
  lines.sort((a, b) => b.ratio - a.ratio || b.n - a.n);
  const out = lines.slice(0, 2).map((l) => l.text);

  const itemsById = new Map(graph.items.map((i) => [i.id, i]));
  for (const nid of neighbourIds(seed, graph)) {
    if (edges.some((e) => e.person === person.id && e.item === nid)) {
      out.push(`worked on "${itemsById.get(nid)!.title}", which is connected to this item`);
      break;
    }
  }
  if (onTeam && team) out.push(`on the ${team} team`);
  return out;
}

/**
 * Top-k people to take over an item. Rank = personalized PageRank (scaled by the best
 * candidate) minus a load penalty plus a small team prior. Deterministic: ties on score
 * break by person id.
 */
export function suggestSuccessors(
  graph: Graph,
  itemId: string,
  cutoff: number,
  opts: SuccessorOptions = {},
): Successor[] {
  const seed = graph.items.find((i) => i.id === itemId);
  if (!seed) return [];
  const k = opts.k ?? 3;
  const loadWeight = opts.loadWeight ?? 0.3;
  const teamBonus = opts.teamBonus ?? 0.1;
  const exclude = new Set(opts.exclude ?? []);

  const { scores } = personalizedPageRank(graph, itemId, cutoff, opts);
  const edges = eligibleEdges(graph, cutoff);

  const botFree = new Set(edges.map((e) => e.person));
  const bots = botIds(graph);
  const candidates = graph.people.filter(
    (p) => !exclude.has(p.id) && p.active !== false && !bots.has(p.id) && (botFree.has(p.id) || (opts.team && p.team === opts.team)),
  );
  const pprOf = (p: Person) => scores.get(pKey(p.id)) ?? 0;
  const maxPpr = candidates.reduce((m, p) => Math.max(m, pprOf(p)), 0);

  const ranked = candidates.map((p): Successor => {
    const ppr = pprOf(p);
    const load = Math.min(1, Math.max(0, opts.loadOverrides?.get(p.id) ?? p.load ?? 0));
    const onTeam = !!opts.team && p.team === opts.team;
    const rel = maxPpr > 0 ? ppr / maxPpr : 0;
    const score = rel - loadWeight * load + (onTeam ? teamBonus : 0);
    return { personId: p.id, name: p.name, score, ppr, load, evidence: buildEvidence(graph, edges, seed, p, onTeam, opts.team) };
  });

  return ranked
    .filter((s) => s.ppr > 0 || s.evidence.length > 0)
    .sort((a, b) => b.score - a.score || (a.personId < b.personId ? -1 : 1))
    .slice(0, k);
}
