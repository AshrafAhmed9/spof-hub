import { describe, expect, it } from 'vitest';
import { buildHandoverPlan, personalizedPageRank, suggestSuccessors, prepareSuccessors, DAY_MS, type Graph } from '../src';

/** Deterministic site: n items over 20 areas, 60 people, a few links. Person p0 is in a lot of them. */
export function bigGraph(n: number): Graph {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const now = Date.UTC(2026, 10, 1);
  const people = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, name: `Person ${i}`, load: rnd() * 0.5 }));
  const items: Graph['items'] = [];
  const edges: Graph['edges'] = [];
  for (let i = 0; i < n; i++) {
    items.push({ id: `K${i % 20}-${i}`, kind: 'workItem', title: `Item ${i}`, area: `area${i % 20}`, open: true, ...(i > 3 && i % 7 === 0 ? { links: [`K${(i - 3) % 20}-${i - 3}`] } : {}) });
    const owner = rnd() < 0.3 ? 0 : Math.floor(rnd() * 60);
    for (let j = 0; j < 4; j++) {
      const who = j < 3 ? owner : Math.floor(rnd() * 60);
      edges.push({ person: `p${who}`, item: items[i]!.id, kind: j === 0 ? 'assigned' : 'commented', at: now - (j + 1) * DAY_MS, weight: 1 });
    }
  }
  return { people, items, edges };
}

describe('plan on a large index', () => {
  const g = bigGraph(3000);
  const from = Date.UTC(2026, 10, 2);
  const req = { leaverId: 'p0', from, to: from + 14 * DAY_MS };

  it('finishes a few thousand items far below the 25 s limit', () => {
    const t = Date.now();
    const plan = buildHandoverPlan(g, req);
    const ms = Date.now() - t;
    expect(plan.totals.items).toBeGreaterThan(300);
    expect(ms).toBeLessThan(10_000);
  });

  it('builds the person-item graph once per plan, not once per item', () => {
    // Counts calls to the table builder through a Proxy on graph.edges: the table walks every edge once per build.
    let walks = 0;
    const counted = { ...g, edges: new Proxy(g.edges, { get(t, k, r) { if (k === Symbol.iterator || k === 'filter') walks++; return Reflect.get(t, k, r); } }) };
    buildHandoverPlan(counted, req);
    // propagateRisk (table + botIds), prepareSuccessors (eligibleEdges + table + botIds) and explain: a handful, never one per item.
    expect(walks).toBeLessThan(20);
  });

  it('gives the same ranking with or without the shared index', () => {
    const ix = prepareSuccessors(g, from);
    for (const id of ['K1-1', 'K7-7', 'K13-2993']) {
      const a = suggestSuccessors(g, id, from, { k: 6, exclude: ['p0'] });
      const b = suggestSuccessors(g, id, from, { k: 6, exclude: ['p0'], index: ix });
      expect(b).toEqual(a);
    }
  });

  it('keeps personalizedPageRank mass at 1', () => {
    const r = personalizedPageRank(g, 'K1-1', from);
    expect([...r.scores.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
  });
});
