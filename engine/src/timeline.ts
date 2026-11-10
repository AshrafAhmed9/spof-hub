import { contributionTable, eligibleEdges, type DecayOptions } from './concentration';
import { DAY_MS, type Graph } from './model';

export interface Absence {
  personId: string;
  /** First day away (ms). */
  from: number;
  /** Last day away (ms), inclusive of that whole day. */
  to: number;
}

export interface TimelineOptions extends DecayOptions {
  /** Days in each column. Default 7. */
  stepDays?: number;
  /** An absent person must hold at least this share of an item for it to count. Default 0.5. */
  heldShare?: number;
  /** Items are "uncovered" when the people present hold less than this share. Default 0.2. */
  remainingShare?: number;
  /** An item needs at least this many recorded contributions to be judged. Default 3. */
  minContributions?: number;
}

export interface TimelineArea {
  area: string;
  uncovered: number;
  itemIds: string[];
}

export interface TimelineStep {
  start: number;
  end: number;
  absent: string[];
  uncovered: number;
  areas: TimelineArea[];
}

/**
 * For each period, which open items have nobody left who knows them: someone who is away held at least
 * `heldShare` of the item, and everyone present together hold less than `remainingShare`.
 * Knowledge is measured as of `now`; absences only change who counts as present.
 */
export function absenceTimeline(
  graph: Graph,
  absences: Absence[],
  start: number,
  steps: number,
  now: number,
  opts: TimelineOptions = {},
): TimelineStep[] {
  const stepMs = (opts.stepDays ?? 7) * DAY_MS;
  const held = opts.heldShare ?? 0.5;
  const remaining = opts.remainingShare ?? 0.2;
  const minContrib = opts.minContributions ?? 3;

  const table = contributionTable(graph, now, opts);
  const counts = new Map<string, number>();
  for (const e of eligibleEdges(graph, now)) counts.set(e.item, (counts.get(e.item) ?? 0) + 1);
  const rows = graph.items
    .filter((i) => i.open && i.kind !== 'goal' && (counts.get(i.id) ?? 0) >= minContrib)
    .map((i) => {
      const row = table.get(i.id)!;
      let total = 0;
      for (const w of row.values()) total += w;
      return { item: i, row, total };
    })
    .filter((r) => r.total > 0);

  const out: TimelineStep[] = [];
  for (let s = 0; s < steps; s++) {
    const a = start + s * stepMs;
    const b = a + stepMs - 1;
    const away = new Set(absences.filter((x) => x.personId && x.from <= b && x.to + DAY_MS - 1 >= a).map((x) => x.personId));
    const byArea = new Map<string, string[]>();
    if (away.size > 0) {
      for (const { item, row, total } of rows) {
        let awayW = 0;
        for (const [p, w] of row) if (away.has(p)) awayW += w;
        const awayShare = awayW / total;
        if (awayShare >= held && 1 - awayShare < remaining) {
          const k = item.area ?? 'No area';
          (byArea.get(k) ?? byArea.set(k, []).get(k)!).push(item.id);
        }
      }
    }
    const areas = [...byArea.entries()]
      .map(([area, itemIds]) => ({ area, uncovered: itemIds.length, itemIds: itemIds.sort() }))
      .sort((x, y) => y.uncovered - x.uncovered || (x.area < y.area ? -1 : 1));
    out.push({ start: a, end: b, absent: [...away].sort(), uncovered: areas.reduce((n, x) => n + x.uncovered, 0), areas });
  }
  return out;
}
