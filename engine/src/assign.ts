/**
 * Capacity-limited assignment of items to people, by minimum-cost maximum flow.
 *
 * Input is, for each item, the people who could take it and how well each fits (higher is better).
 * Output is one person per item (or null) such that nobody gets more than their capacity, as many items
 * as possible are covered, and among all such assignments the total fit is the highest.
 *
 * Costs are scaled to integers so the result does not depend on floating-point rounding. Ties
 * resolve by edge order, which follows the candidate order given, so the output is deterministic.
 */
export interface Candidate {
  personId: string;
  score: number;
}

export function assignWithCapacity(
  candidates: Candidate[][],
  capacityOf: (personId: string) => number,
): Array<string | null> {
  const n = candidates.length;
  const people = [...new Set(candidates.flatMap((c) => c.map((x) => x.personId)))].sort();
  const m = people.length;
  if (n === 0 || m === 0) return candidates.map(() => null);
  const pIndex = new Map(people.map((p, i) => [p, i]));
  const best = Math.max(...candidates.flatMap((c) => c.map((x) => x.score)));

  const S = 0;
  const T = n + m + 1;
  type Edge = { to: number; cap: number; cost: number; rev: number };
  const g: Edge[][] = Array.from({ length: T + 1 }, () => []);
  const add = (a: number, b: number, cap: number, cost: number) => {
    g[a]!.push({ to: b, cap, cost, rev: g[b]!.length });
    g[b]!.push({ to: a, cap: 0, cost: -cost, rev: g[a]!.length - 1 });
  };
  for (let i = 0; i < n; i++) {
    add(S, 1 + i, 1, 0);
    for (const c of candidates[i]!) add(1 + i, 1 + n + pIndex.get(c.personId)!, 1, Math.round((best - c.score) * 1e6));
  }
  for (let j = 0; j < m; j++) add(1 + n + j, T, Math.max(0, Math.floor(capacityOf(people[j]!))), 0);

  // Successive shortest paths (SPFA). Each round sends one unit; stops when no path remains.
  for (;;) {
    const dist = new Array<number>(T + 1).fill(Infinity);
    const inQ = new Array<boolean>(T + 1).fill(false);
    const prevNode = new Array<number>(T + 1).fill(-1);
    const prevEdge = new Array<number>(T + 1).fill(-1);
    dist[S] = 0;
    const queue = [S];
    for (let h = 0; h < queue.length; h++) {
      const u = queue[h]!;
      inQ[u] = false;
      g[u]!.forEach((e, idx) => {
        if (e.cap > 0 && dist[u]! + e.cost < dist[e.to]!) {
          dist[e.to] = dist[u]! + e.cost;
          prevNode[e.to] = u;
          prevEdge[e.to] = idx;
          if (!inQ[e.to]) {
            inQ[e.to] = true;
            queue.push(e.to);
          }
        }
      });
    }
    if (dist[T]! === Infinity) break;
    for (let v = T; v !== S; v = prevNode[v]!) {
      const e = g[prevNode[v]!]![prevEdge[v]!]!;
      e.cap -= 1;
      g[v]![e.rev]!.cap += 1;
    }
  }

  return candidates.map((_, i) => {
    for (const e of g[1 + i]!) if (e.to > n && e.to <= n + m && e.cap === 0) return people[e.to - n - 1]!;
    return null;
  });
}
