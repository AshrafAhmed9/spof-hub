// Read-only analysis on an engine Graph: coverage by area, single points, one-item evidence.
import {
  areaTruckFactor,
  concentrationOf,
  contributionTable,
  explainConcentration,
  isBot,
  type Graph,
  type Item,
} from './engine';
import type { AreaCoverage, CoverageResponse } from '../shared/contract';

/** An item counts as a single point when one person holds at least this share. */
export const SINGLE_POINT = 0.8;
/** Below this share nobody is called "the" owner. */
export const OWNER_MIN = 0.5;

export function currentAssignee(g: Graph, itemId: string): string | null {
  let best: { p: string; at: number } | null = null;
  for (const e of g.edges) if (e.item === itemId && e.kind === 'assigned' && (!best || e.at > best.at)) best = { p: e.person, at: e.at };
  return best?.p ?? null;
}

export interface ItemTop { itemId: string; personId: string; share: number; assignee: string | null }

export function topPerItem(g: Graph, now: number, items?: Item[]): ItemTop[] {
  const table = contributionTable(g, now);
  const out: ItemTop[] = [];
  const humans = g.people.filter((p) => !p.isBot && !isBot(p.name));
  for (const it of items ?? g.items) {
    if (it.kind === 'goal' || !it.open) continue;
    let best: { id: string; s: number } | null = null;
    for (const p of humans) {
      const s = concentrationOf(table, it.id, p.id);
      if (s > 0 && (!best || s > best.s || (s === best.s && p.id < best.id))) best = { id: p.id, s };
    }
    if (best) out.push({ itemId: it.id, personId: best.id, share: best.s, assignee: currentAssignee(g, it.id) });
  }
  return out;
}

export function computeCoverage(g: Graph, now: number): Omit<CoverageResponse, 'mode' | 'generatedAt' | 'partial' | 'notes'> {
  const names = new Map(g.people.map((p) => [p.id, p.name]));
  const tops = topPerItem(g, now);
  const topById = new Map(tops.map((t) => [t.itemId, t]));
  const byArea = new Map<string, Item[]>();
  for (const it of g.items) if (it.kind !== 'goal' && it.open) (byArea.get(it.area ?? 'No area') ?? byArea.set(it.area ?? 'No area', []).get(it.area ?? 'No area')!).push(it);

  const areas: AreaCoverage[] = [];
  for (const [area, items] of byArea) {
    const t = areaTruckFactor(g, items, now);
    const sums = new Map<string, number>();
    let unassigned = 0;
    for (const it of items) {
      const top = topById.get(it.id);
      if (!top) continue;
      sums.set(top.personId, (sums.get(top.personId) ?? 0) + top.share);
    }
    const ranked = [...sums.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const [topId, topSum] = ranked[0] ?? ['', 0];
    for (const it of items) {
      const top = topById.get(it.id);
      if (top && top.personId === topId && top.share >= OWNER_MIN && top.assignee !== topId) unassigned++;
    }
    areas.push({
      area,
      items: items.length,
      truckFactor: t.truckFactor,
      topPerson: { id: topId, name: names.get(topId) ?? topId, share: items.length ? topSum / items.length : 0 },
      unassignedToTop: unassigned,
    });
  }
  areas.sort((a, b) => a.truckFactor - b.truckFactor || b.topPerson.share - a.topPerson.share || (a.area < b.area ? -1 : 1));

  return {
    areas,
    totals: {
      itemsScanned: g.items.filter((i) => i.kind !== 'goal').length,
      singlePointItems: tops.filter((t) => t.share >= SINGLE_POINT).length,
      invisibleToAssignee: tops.filter((t) => t.share >= OWNER_MIN && t.assignee !== null && t.assignee !== t.personId).length,
    },
  };
}

export interface SinglePoint {
  itemId: string;
  title: string;
  area: string;
  holder: { id: string; name: string; share: number };
  assignee: string | null;
  evidence: string[];
}

export function findSinglePoints(g: Graph, now: number, opts: { area?: string; limit?: number; minShare?: number } = {}): SinglePoint[] {
  const names = new Map(g.people.map((p) => [p.id, p.name]));
  const items = new Map(g.items.map((i) => [i.id, i]));
  const area = opts.area?.toLowerCase();
  const min = opts.minShare ?? SINGLE_POINT;
  return topPerItem(g, now)
    .filter((t) => t.share >= min && (!area || (items.get(t.itemId)?.area ?? '').toLowerCase().includes(area)))
    .sort((a, b) => b.share - a.share || (a.itemId < b.itemId ? -1 : 1))
    .slice(0, opts.limit ?? 15)
    .map((t) => {
      const it = items.get(t.itemId)!;
      return {
        itemId: t.itemId,
        title: it.title,
        area: it.area ?? 'No area',
        holder: { id: t.personId, name: names.get(t.personId) ?? t.personId, share: round(t.share) },
        assignee: t.assignee ? (names.get(t.assignee) ?? t.assignee) : null,
        evidence: explainConcentration(g, t.itemId, t.personId, now).reasons,
      };
    });
}

export const round = (n: number) => Math.round(n * 100) / 100;
