// Successor backtest runner (DEFINITIONS_SUCCESSOR.md). Reads succ_<PROJECT>.json from export_successor.py,
// ranks the pool with the engine and the baselines using only comments at or before T, writes ranks_<PROJECT>.json.
// Run: ../engine/node_modules/.bin/vite-node rank_successor.ts SPARK
import { readFileSync, writeFileSync } from 'node:fs';
import { suggestSuccessors, type Edge, type Graph } from '../engine/src/index';

const project = process.argv[2];
const restart = process.argv[3] ? Number(process.argv[3]) : undefined;
const tag = restart === undefined ? '' : `_r${restart}`;
const data = JSON.parse(readFileSync(new URL(`./succ_${project}.json`, import.meta.url), 'utf8')) as {
  items: Array<{ key: string; created: number; comments: Array<[number, string]> }>;
  pairs: Array<{ L: string; T: number; key: string; P: string }>;
  pool_days: number;
};
const DAY = 86400;
const byLeaver = new Map<string, typeof data.pairs>();
for (const p of data.pairs) (byLeaver.get(p.L) ?? byLeaver.set(p.L, []).get(p.L)!).push(p);
const itemByKey = new Map(data.items.map((i) => [i.key, i]));
const allPeople = [...new Set(data.items.flatMap((i) => i.comments.map(([, p]) => p)))].sort();
const out: Array<Record<string, unknown>> = [];
let done = 0;

for (const [L, pairs] of byLeaver) {
  const T = pairs[0].T;
  const items = data.items.filter((i) => i.created < T);
  const edges: Edge[] = [];
  const active = new Map<string, number>(); // comments in (T - pool_days, T] per person
  for (const it of items) {
    for (const [t, p] of it.comments) {
      if (t > T) continue;
      edges.push({ person: p, item: it.key, kind: 'commented', at: t * 1000, weight: 0.5 });
      if (t > T - data.pool_days * DAY && p !== L) active.set(p, (active.get(p) ?? 0) + 1);
    }
  }
  const graph: Graph = {
    people: allPeople.map((id) => ({ id, name: id })),
    items: items.map((i) => ({ id: i.key, kind: 'workItem', title: i.key, open: true })),
    edges,
  };
  const pool = [...active.keys()].sort();
  const poolSet = new Set(pool);
  const exclude = allPeople.filter((p) => !poolSet.has(p));
  // Method 2 order, also the tie order for everything unscored.
  const activeOrder = [...pool].sort((a, b) => active.get(b)! - active.get(a)! || (a < b ? -1 : 1));

  for (const pr of pairs) {
    const it = itemByKey.get(pr.key)!;
    const pre = it.comments.filter(([t]) => t <= T && true);
    const counts = new Map<string, number>();
    const lastAt = new Map<string, number>();
    for (const [t, p] of pre) {
      if (p === L) continue;
      counts.set(p, (counts.get(p) ?? 0) + 1);
      lastAt.set(p, Math.max(lastAt.get(p) ?? 0, t));
    }
    const rankIn = (order: string[]) => order.indexOf(pr.P) + 1;
    const withFallback = (first: string[]) => [...first, ...activeOrder.filter((p) => !first.includes(p))];
    const topOnItem = [...counts.keys()].filter((p) => poolSet.has(p)).sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : 1));
    const lastOnItem = [...lastAt.keys()].filter((p) => poolSet.has(p)).sort((a, b) => lastAt.get(b)! - lastAt.get(a)! || (a < b ? -1 : 1));
    const ranked = suggestSuccessors(graph, pr.key, T * 1000, { k: pool.length, exclude: [L, ...exclude], ...(restart === undefined ? {} : { restart }) }).map((s) => s.personId);
    out.push({
      L, key: pr.key, P: pr.P, n: pool.length,
      engine: rankIn(withFallback(ranked)),
      active: rankIn(activeOrder),
      topOnItem: rankIn(withFallback(topOnItem)),
      lastOnItem: rankIn(withFallback(lastOnItem)),
      itemHadOthers: counts.size > 0,
      pTouchedItem: counts.has(pr.P),
    });
  }
  done++;
  if (done % 5 === 0) console.error(project, done, '/', byLeaver.size, 'leavers');
}
writeFileSync(new URL(`./ranks_${project}${tag}.json`, import.meta.url), JSON.stringify(out));
console.error(project, 'done', out.length, 'pairs');
