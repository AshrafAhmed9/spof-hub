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
