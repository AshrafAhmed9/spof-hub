import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  areaTruckFactor, buildHandoverPlan, concentrationOf, contributionTable, DAY_MS,
  explainConcentration, explainRisk, itemConcentration, personalizedPageRank,
  propagateRisk, suggestSuccessors, type Edge, type EdgeKind, type Graph, type Item,
} from '../src';
import { fixtureOrg, NOW } from './fixture';

const wi = (id: string): Item => ({ id, kind: 'workItem', title: id, open: true });
const e = (person: string, item: string, daysAgo = 0, kind: EdgeKind = 'authored', weight = 1): Edge => ({
  person, item, kind, at: NOW - daysAgo * DAY_MS, weight,
});
const g = (itemIds: string[], edges: Edge[], people = ['x', 'y', 'z']): Graph => ({
  people: people.map((id) => ({ id, name: id })),
  items: itemIds.map(wi),
  edges,
});

describe('concentration', () => {
  it('sole contributor is 1, bots are excluded', () => {
    expect(itemConcentration(fixtureOrg, 'A1', 'priya', NOW)).toBeCloseTo(1, 12);
    expect(itemConcentration(fixtureOrg, 'A1', 'bot', NOW)).toBe(0);
  });

  it('does not decay by default: old and new activity count the same', () => {
    const gr = g(['i'], [e('x', 'i', 1800), e('y', 'i', 0)]);
    expect(itemConcentration(gr, 'i', 'y', NOW)).toBeCloseTo(0.5, 12);
    expect(itemConcentration(gr, 'i', 'x', NOW)).toBeCloseTo(0.5, 12);
  });

  it('halves weight per half-life when decay is enabled', () => {
    const gr = g(['i'], [e('x', 'i', 180), e('y', 'i', 0)]);
    expect(itemConcentration(gr, 'i', 'y', NOW, { halfLifeDays: 180 })).toBeCloseTo(1 / 1.5, 9);
    expect(itemConcentration(gr, 'i', 'y', NOW, { halfLifeDays: 90 })).toBeCloseTo(1 / 1.25, 9);
  });

  it('ignores activity after the cutoff', () => {
    const gr = g(['i'], [e('x', 'i', 10), e('y', 'i', -5)]);
    expect(itemConcentration(gr, 'i', 'x', NOW)).toBe(1);
    expect(itemConcentration(gr, 'i', 'x', NOW + 10 * DAY_MS)).toBeLessThan(1);
  });

  it('returns 0 for items with no contributions', () => {
    expect(itemConcentration(g(['i'], []), 'i', 'x', NOW)).toBe(0);
  });
});

describe('areaTruckFactor', () => {
  it('is 1 when one person owns everything', () => {
    const gr = g(['a', 'b', 'c'], [e('x', 'a'), e('x', 'b'), e('x', 'c'), e('y', 'c')]);
    expect(areaTruckFactor(gr, gr.items, NOW).truckFactor).toBe(1);
  });

  it('needs both people when work splits 50/50', () => {
    const gr = g(['a', 'b', 'c', 'd'], [e('x', 'a'), e('x', 'b'), e('y', 'c'), e('y', 'd')]);
    const r = areaTruckFactor(gr, gr.items, NOW);
    expect(r.truckFactor).toBe(2);
    expect(r.removed).toEqual(['x', 'y']);
  });

  it('is 0 for an empty area', () => {
    expect(areaTruckFactor(g([], []), [], NOW).truckFactor).toBe(0);
  });

  it('ignores bots and non-work items', () => {
    const gr = g(['a'], [e('bot', 'a'), e('x', 'a')], ['x', 'bot']);
    expect(areaTruckFactor(gr, gr.items, NOW).removed).toEqual(['x']);
    expect(areaTruckFactor(fixtureOrg, ['P1', 'G1'], NOW).truckFactor).toBe(0);
  });

  it('matches the hand-built fixture areas', () => {
    const area = (a: string) => fixtureOrg.items.filter((i) => i.kind === 'workItem' && i.area === a);
    expect(areaTruckFactor(fixtureOrg, area('auth'), NOW)).toMatchObject({ truckFactor: 1, removed: ['priya'] });
    expect(areaTruckFactor(fixtureOrg, area('billing'), NOW).truckFactor).toBe(2);
    expect(areaTruckFactor(fixtureOrg, area('platform'), NOW).truckFactor).toBe(2);
  });
});

// random graphs for property tests
const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4'];
const ITEMS = ['i0', 'i1', 'i2', 'i3', 'i4', 'i5'];
const KINDS: EdgeKind[] = ['assigned', 'commented', 'answered', 'authored', 'reviewed', 'owns', 'linked'];
const edgeArb = fc.record({
  person: fc.constantFrom(...PEOPLE),
  item: fc.constantFrom(...ITEMS),
  kind: fc.constantFrom(...KINDS),
  at: fc.integer({ min: 0, max: 800 }).map((d) => NOW - d * DAY_MS),
  weight: fc.double({ min: 0.01, max: 10, noNaN: true }),
});
const graphArb = fc.record({
  edges: fc.array(edgeArb, { maxLength: 40 }),
  deps: fc.array(fc.tuple(fc.constantFrom(...ITEMS), fc.constantFrom(...ITEMS)), { maxLength: 8 }),
  halfLife: fc.integer({ min: 7, max: 720 }),
}).map(({ edges, deps, halfLife }) => {
  const items: Item[] = ITEMS.map((id) => ({
    id, kind: 'workItem', title: id, open: true, priority: 'high', dueAt: NOW + 3 * DAY_MS,
    blocks: deps.filter(([a]) => a === id).map(([, b]) => b),
  }));
  return { graph: { people: PEOPLE.map((id) => ({ id, name: id })), items, edges } as Graph, halfLife };
});

describe('properties', () => {
  it('concentration is in [0,1] and shares sum to 1 or 0', () => {
    fc.assert(fc.property(graphArb, ({ graph, halfLife }) => {
      const t = contributionTable(graph, NOW, { halfLifeDays: halfLife });
      for (const it of ITEMS) {
        let sum = 0;
        for (const p of PEOPLE) {
          const c = concentrationOf(t, it, p);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
          sum += c;
        }
        expect(sum === 0 || Math.abs(sum - 1) < 1e-9).toBe(true);
      }
    }));
  });

  it('a new contributor never raises anyone else\'s concentration', () => {
    fc.assert(fc.property(
      graphArb, fc.constantFrom(...PEOPLE), fc.constantFrom(...ITEMS),
      fc.integer({ min: 0, max: 800 }), fc.double({ min: 0.01, max: 10, noNaN: true }),
      ({ graph, halfLife }, who, item, d, w) => {
        const other = PEOPLE.find((p) => p !== who)!;
        const before = itemConcentration(graph, item, who, NOW, { halfLifeDays: halfLife });
        const more = { ...graph, edges: [...graph.edges, e(other, item, d, 'commented', w)] };
        const after = itemConcentration(more, item, who, NOW, { halfLifeDays: halfLife });
        expect(after).toBeLessThanOrEqual(before + 1e-12);
      }));
  });

  it('PPR converges, is non-negative and sums to ~1', () => {
    fc.assert(fc.property(graphArb, fc.constantFrom(...ITEMS), ({ graph, halfLife }, seed) => {
      const r = personalizedPageRank(graph, seed, NOW, { halfLifeDays: halfLife });
      expect(r.converged).toBe(true);
      let sum = 0;
      for (const v of r.scores.values()) {
        expect(v).toBeGreaterThanOrEqual(0);
        sum += v;
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }));
  });

  it('propagated risk stays in [0,1], is >= own risk, and is deterministic', () => {
    fc.assert(fc.property(graphArb, fc.constantFrom(...PEOPLE), ({ graph, halfLife }, who) => {
      const a = propagateRisk(graph, who, NOW, NOW, { halfLifeDays: halfLife });
      const b = propagateRisk(graph, who, NOW, NOW, { halfLifeDays: halfLife });
      expect(a).toEqual(b);
      for (const r of a) {
        expect(r.total).toBeGreaterThanOrEqual(0);
        expect(r.total).toBeLessThanOrEqual(1);
        expect(r.total).toBeGreaterThanOrEqual(r.own - 1e-12);
        expect(r.iterations).toBeLessThanOrEqual(20);
      }
    }));
  });

  it('truck factor never exceeds the number of contributors', () => {
    fc.assert(fc.property(graphArb, ({ graph }) => {
      const r = areaTruckFactor(graph, graph.items, NOW);
      const people = new Set(graph.edges.map((x) => x.person));
      expect(r.truckFactor).toBeLessThanOrEqual(people.size);
    }));
  });
});

describe('propagation', () => {
  it('closed items carry no risk; blockers pass risk to blocked items and goals', () => {
    const risks = new Map(propagateRisk(fixtureOrg, 'priya', NOW, NOW).map((r) => [r.itemId, r]));
    expect(risks.get('A10')!.own).toBe(0);
    expect(risks.get('A9')!.inherited).toBeGreaterThan(0);
    expect(risks.get('A9')!.via).toBe('A1');
    expect(risks.get('G1')!.total).toBeGreaterThan(0.5);
    expect(risks.get('G2')!.total).toBeLessThan(risks.get('G1')!.total);
  });

  it('survives dependency cycles', () => {
    const gr = g(['a', 'b'], [e('x', 'a'), e('x', 'b')]);
    gr.items[0]!.blocks = ['b'];
    gr.items[1]!.blocks = ['a'];
    const r = propagateRisk(gr, 'x', NOW, NOW);
    expect(r.every((s) => s.total <= 1)).toBe(true);
  });

  it('overdue and highest priority raise risk over a lazy low-priority item', () => {
    const r = new Map(propagateRisk(fixtureOrg, 'priya', NOW, NOW).map((x) => [x.itemId, x.own]));
    expect(r.get('A1')!).toBeGreaterThan(r.get('A5')!);
    expect(r.get('A6')!).toBeGreaterThan(r.get('A4')!);
  });
});

describe('successors', () => {
  it('picks Ana over Omar for Priya\'s auth work, never the leaver or the bot', () => {
    const s = suggestSuccessors(fixtureOrg, 'A9', NOW, { exclude: ['priya'], team: 'auth' });
    expect(s[0]!.personId).toBe('ana');
    expect(s.map((x) => x.personId)).not.toContain('priya');
    expect(s.map((x) => x.personId)).not.toContain('bot');
    expect(s[0]!.evidence.length).toBeGreaterThan(0);
  });

  it('writes evidence like "answered 2 of 7 questions on this component"', () => {
    const s = suggestSuccessors(fixtureOrg, 'A9', NOW, { exclude: ['priya'], team: 'auth' });
    expect(s[0]!.evidence.join(' | ')).toMatch(/\d+ of \d+ \w+ on this component/);
  });

  it('load lowers a candidate\'s score', () => {
    const base = suggestSuccessors(fixtureOrg, 'A7', NOW, { exclude: ['priya'], team: 'auth' });
    const loaded = suggestSuccessors(fixtureOrg, 'A7', NOW, {
      exclude: ['priya'], team: 'auth', loadOverrides: new Map([[base[0]!.personId, 1]]),
    });
    const same = loaded.find((x) => x.personId === base[0]!.personId)!;
    expect(same.score).toBeCloseTo(base[0]!.score - 0.3 * (1 - base[0]!.load), 9);
  });

  it('is empty for an unknown item', () => {
    expect(suggestSuccessors(fixtureOrg, 'nope', NOW)).toEqual([]);
  });
});

describe('explain', () => {
  it('names a sole contributor', () => {
    const x = explainConcentration(fixtureOrg, 'A1', 'priya', NOW);
    expect(x.score).toBeCloseTo(1, 9);
    expect(x.reasons[0]).toBe('Only Priya Nair has answered here (2 of 2 replies)');
    expect(x.breakdown.contributors).toHaveLength(1);
  });

  it('explains shared ownership and absence', () => {
    const shared = explainConcentration(fixtureOrg, 'A8', 'priya', NOW);
    expect(shared.reasons[0]).toMatch(/is one of 2 contributors|holds/);
    expect(explainConcentration(fixtureOrg, 'B1', 'priya', NOW).reasons[0]).toBe('Priya Nair has not contributed here');
  });

  it('explains risk with due date and inheritance', () => {
    const r = propagateRisk(fixtureOrg, 'priya', NOW, NOW).find((x) => x.itemId === 'A9')!;
    const x = explainRisk(fixtureOrg, r, 'priya', NOW);
    expect(x.reasons.join('|')).toMatch(/Picks up risk from/);
    const a6 = explainRisk(fixtureOrg, propagateRisk(fixtureOrg, 'priya', NOW, NOW).find((y) => y.itemId === 'A6')!, 'priya', NOW);
    expect(a6.reasons).toContain('Overdue by 3 days');
  });
});

describe('handover plan', () => {
  const req = { leaverId: 'priya', from: NOW, to: NOW + 30 * DAY_MS };

  it('is deterministic and idempotent', () => {
    const a = buildHandoverPlan(fixtureOrg, req);
    const b = buildHandoverPlan(JSON.parse(JSON.stringify(fixtureOrg)) as typeof fixtureOrg, req);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('groups at-risk items by area with unique operation keys and no leaver/bot successors', () => {
    const plan = buildHandoverPlan(fixtureOrg, req);
    expect(plan.groups.map((x) => x.area)[0]).toBe('auth');
    const all = plan.groups.flatMap((x) => x.entries);
    expect(all.length).toBe(plan.totals.items);
    expect(new Set(all.map((x) => x.operationKey)).size).toBe(all.length);
    for (const en of all) {
      expect(['priya', 'bot']).not.toContain(en.successor?.personId);
      expect(en.reasons.length).toBeGreaterThan(0);
    }
    expect(all.find((x) => x.itemId === 'A10')).toBeUndefined(); // closed
    expect(all.find((x) => x.itemId === 'G1')).toBeUndefined(); // goal
    for (const grp of plan.groups) {
      const risks = grp.entries.map((x) => x.risk);
      expect(risks).toEqual([...risks].sort((a, b) => b - a));
    }
  });

  it('spreads work as load accumulates and changes keys for another window', () => {
    const plan = buildHandoverPlan(fixtureOrg, req, { loadStep: 0.3 });
    const picks = new Set(plan.groups.flatMap((x) => x.entries).map((x) => x.successor?.personId));
    expect(picks.size).toBeGreaterThan(1);
    const other = buildHandoverPlan(fixtureOrg, { ...req, to: req.to + DAY_MS });
    expect(other.planKey).not.toBe(plan.planKey);
  });

  it('flags items due during the absence', () => {
    const all = buildHandoverPlan(fixtureOrg, req).groups.flatMap((x) => x.entries);
    expect(all.find((x) => x.itemId === 'A1')!.dueDuringAbsence).toBe(true);
    expect(all.find((x) => x.itemId === 'A6')!.dueDuringAbsence).toBe(false);
  });

  it('returns an empty plan for someone with no knowledge', () => {
    const plan = buildHandoverPlan(fixtureOrg, { ...req, leaverId: 'nobody' });
    expect(plan.groups).toEqual([]);
  });
});

describe('fixture', () => {
  it('has 8 people and 30 items', () => {
    expect(fixtureOrg.people).toHaveLength(8);
    expect(fixtureOrg.items).toHaveLength(30);
  });
});
