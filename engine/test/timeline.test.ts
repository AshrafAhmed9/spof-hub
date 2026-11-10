import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { absenceTimeline, DAY_MS, type Edge, type Graph } from '../src';
import { fixtureOrg, NOW } from './fixture';

const wk = (n: number) => NOW + n * 7 * DAY_MS;
const edge = (person: string, item: string): Edge => ({ person, item, kind: 'commented', at: NOW - DAY_MS, weight: 1 });
const small: Graph = {
  people: ['a', 'b', 'c'].map((id) => ({ id, name: id })),
  items: [
    { id: 'X1', kind: 'workItem', title: 'x1', area: 'Pay', open: true },
    { id: 'X2', kind: 'workItem', title: 'x2', area: 'Pay', open: true },
    { id: 'Y1', kind: 'workItem', title: 'y1', area: 'Auth', open: true },
    { id: 'Z1', kind: 'workItem', title: 'z1', area: 'Auth', open: false },
  ],
  edges: [
    ...[1, 2, 3, 4].map(() => edge('a', 'X1')), // only a knows X1
    ...[1, 2].map(() => edge('a', 'X2')), ...[1, 2, 3].map(() => edge('b', 'X2')), // shared
    ...[1, 2, 3].map(() => edge('b', 'Y1')),
    ...[1, 2, 3].map(() => edge('a', 'Z1')), // closed
  ],
};

describe('absenceTimeline', () => {
  it('flags only items nobody present knows, in the weeks someone is away', () => {
    const t = absenceTimeline(small, [{ personId: 'a', from: wk(1), to: wk(1) + 3 * DAY_MS }], wk(0), 3, NOW);
    expect(t.map((s) => s.uncovered)).toEqual([0, 1, 0]);
    expect(t[1]!.areas).toEqual([{ area: 'Pay', uncovered: 1, itemIds: ['X1'] }]); // not X2 (b also knows it), not closed Z1
    expect(t[1]!.absent).toEqual(['a']);
  });

  it('counts a whole last day, and an absence that spans several weeks', () => {
    const t = absenceTimeline(small, [{ personId: 'b', from: wk(0), to: wk(2) }], wk(0), 3, NOW);
    expect(t.map((s) => s.uncovered)).toEqual([1, 1, 1]); // Y1 only b knows
  });

  it('is quiet when nobody is away or when the item has too little history', () => {
    expect(absenceTimeline(small, [], wk(0), 2, NOW).every((s) => s.uncovered === 0)).toBe(true);
    const thin: Graph = { ...small, edges: [edge('a', 'X1')] };
    expect(absenceTimeline(thin, [{ personId: 'a', from: wk(0), to: wk(1) }], wk(0), 1, NOW)[0]!.uncovered).toBe(0);
  });

  it('adding an absence never uncovers fewer items (property)', () => {
    const ids = fixtureOrg.people.map((p) => p.id);
    fc.assert(
      fc.property(fc.array(fc.record({ i: fc.integer({ min: 0, max: ids.length - 1 }), w: fc.integer({ min: 0, max: 3 }), len: fc.integer({ min: 0, max: 14 }) }), { maxLength: 5 }), fc.nat(4), (list, extra) => {
        const mk = (x: { i: number; w: number; len: number }) => ({ personId: ids[x.i]!, from: wk(x.w), to: wk(x.w) + x.len * DAY_MS });
        const base = list.map(mk);
        const more = [...base, mk({ i: extra % ids.length, w: extra % 4, len: 6 })];
        const a = absenceTimeline(fixtureOrg, base, wk(0), 4, NOW);
        const b = absenceTimeline(fixtureOrg, more, wk(0), 4, NOW);
        a.forEach((s, k) => expect(b[k]!.uncovered).toBeGreaterThanOrEqual(s.uncovered));
      }),
      { numRuns: 100 },
    );
  });
});
