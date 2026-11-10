import { describe, expect, it } from 'vitest';
import { computeCoverage, findSinglePoints, MIN_EVIDENCE } from './analysis';
import { loadSample } from './sample';
import type { Graph } from './engine';

const NOW = Date.UTC(2026, 10, 1);
const graph = (contributions: number): Graph => ({
  people: [{ id: 'u1', name: 'Dana', isBot: false, load: 0 } as any],
  items: [{ id: 'ABC-1', kind: 'workItem', title: 'T', open: true, area: 'ABC' } as any],
  edges: Array.from({ length: contributions }, (_, i) => ({ person: 'u1', item: 'ABC-1', kind: 'commented', at: NOW - i * 1000, weight: 1 })) as any,
});

describe('single point evidence', () => {
  it('does not call an item with one contribution a single point', () => {
    expect(findSinglePoints(graph(1), NOW)).toHaveLength(0);
    expect(computeCoverage(graph(1), NOW).totals.singlePointItems).toBe(0);
  });
  it('does once there is enough activity from one person', () => {
    expect(findSinglePoints(graph(MIN_EVIDENCE), NOW)).toHaveLength(1);
    expect(computeCoverage(graph(MIN_EVIDENCE), NOW).totals.singlePointItems).toBe(1);
  });
  it('still shows single points in the sample company', () => {
    const s = loadSample(NOW);
    expect(computeCoverage(s.graph, s.asOf).totals.singlePointItems).toBeGreaterThan(0);
  });
});

describe('plan limit per person (service level)', () => {
  it('passes the limit to the planner and no one exceeds it', async () => {
    const { buildPlanFor } = await import('./service');
    const { memoryStore } = await import('./kv');
    const now = Date.UTC(2026, 10, 10);
    const s = loadSample(now);
    // Pick the person holding the most single points so the plan has real work in it.
    const { topPerItem } = await import('./analysis');
    const tally = new Map<string, number>();
    for (const t of topPerItem(s.graph, now)) tally.set(t.personId, (tally.get(t.personId) ?? 0) + 1);
    const leaverId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const deps: any = { store: memoryStore(), now: () => now, api: {}, sample: () => s };
    const req = { leaverId, from: now, to: now + 14 * 86_400_000 };
    const loose = await buildPlanFor(deps, 'sample', req, { persist: false });
    const capped = await buildPlanFor(deps, 'sample', { ...req, maxPerPerson: 2 }, { persist: false });
    const count = (p: typeof loose) => {
      const m = new Map<string, number>();
      for (const g of p.plan.groups) for (const e of g.entries) if (e.successor) m.set(e.successor.personId, (m.get(e.successor.personId) ?? 0) + 1);
      return Math.max(0, ...m.values());
    };
    expect(count(capped)).toBeLessThanOrEqual(2);
    expect(capped.plan.planKey).not.toBe(loose.plan.planKey);
  });
});

describe('timeline (service level)', () => {
  it('shows nothing uncovered with no leave, and some when the main holder of work is away', async () => {
    const { timeline } = await import('./service');
    const { memoryStore } = await import('./kv');
    const { topPerItem } = await import('./analysis');
    const now = Date.UTC(2026, 10, 10);
    const s = loadSample(now);
    const tally = new Map<string, number>();
    for (const t of topPerItem(s.graph, now)) tally.set(t.personId, (tally.get(t.personId) ?? 0) + 1);
    const deps: any = { store: memoryStore(), now: () => now, api: {}, sample: () => s };
    // The sample company has people whose absence leaves items with nobody who knows them; find one.
    let holder = '';
    for (const id of [...tally.keys()]) {
      const t = await timeline(deps, 'sample', { absences: [{ personId: id, from: now, to: now + 6 * 86_400_000 }], weeks: 1 });
      if (t.steps[0]!.uncovered > 0) { holder = id; break; }
    }
    expect(holder).not.toBe('');
    const none = await timeline(deps, 'sample', { absences: [], weeks: 4 });
    expect(none.steps).toHaveLength(4);
    expect(none.steps.every((x) => x.uncovered === 0)).toBe(true);
    const away = await timeline(deps, 'sample', { absences: [{ personId: holder, from: now + 7 * 86_400_000, to: now + 13 * 86_400_000 }], weeks: 4 });
    expect(away.steps[0]!.uncovered).toBe(0);
    expect(away.steps[1]!.absent.map((p) => p.id)).toEqual([holder]);
    expect(away.steps[1]!.uncovered).toBeGreaterThan(0);
    expect(away.steps[1]!.areas[0]!.items.length).toBe(away.steps[1]!.areas[0]!.uncovered);
    expect(away.steps[2]!.uncovered).toBe(0);
    // Unknown people and reversed dates are ignored rather than throwing.
    const odd = await timeline(deps, 'sample', { absences: [{ personId: 'nobody', from: now, to: now + 1 }, { personId: holder, from: now + 5, to: now }], weeks: 2 });
    expect(odd.steps.every((x) => x.absent.length === 0)).toBe(true);
  });
});
