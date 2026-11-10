import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { assignWithCapacity, buildHandoverPlan, type Candidate } from '../src';
import { fixtureOrg, NOW } from './fixture';

/** Best total score over every assignment that respects the capacity and covers as many items as possible. */
function brute(c: Candidate[][], cap: number): { covered: number; score: number } {
  let best = { covered: -1, score: -Infinity };
  const used = new Map<string, number>();
  const go = (i: number, covered: number, score: number) => {
    if (i === c.length) {
      if (covered > best.covered || (covered === best.covered && score > best.score + 1e-9)) best = { covered, score };
      return;
    }
    go(i + 1, covered, score);
    for (const x of c[i]!) {
      if ((used.get(x.personId) ?? 0) >= cap) continue;
      used.set(x.personId, (used.get(x.personId) ?? 0) + 1);
      go(i + 1, covered + 1, score + x.score);
      used.set(x.personId, used.get(x.personId)! - 1);
    }
  };
  go(0, 0, 0);
  return best;
}

const cand = fc.array(
  fc.uniqueArray(fc.record({ personId: fc.constantFrom('a', 'b', 'c', 'd'), score: fc.integer({ min: -20, max: 100 }).map((n) => n / 10) }), {
    selector: (x) => x.personId, maxLength: 4,
  }),
  { minLength: 1, maxLength: 6 },
);

describe('assignWithCapacity', () => {
  it('matches brute force: same coverage, same total fit, nobody over capacity', () => {
    fc.assert(
      fc.property(cand, fc.integer({ min: 1, max: 3 }), (c, cap) => {
        const out = assignWithCapacity(c, () => cap);
        const counts = new Map<string, number>();
        let score = 0;
        let covered = 0;
        out.forEach((p, i) => {
          if (!p) return;
          const x = c[i]!.find((y) => y.personId === p);
          expect(x).toBeDefined(); // only ever a listed candidate
          counts.set(p, (counts.get(p) ?? 0) + 1);
          score += x!.score;
          covered++;
        });
        for (const n of counts.values()) expect(n).toBeLessThanOrEqual(cap);
        const b = brute(c, cap);
        expect(covered).toBe(b.covered);
        expect(score).toBeCloseTo(b.score, 5);
      }),
      { numRuns: 300 },
    );
  });

  it('gives the same answer every time', () => {
    const c = [[{ personId: 'a', score: 1 }, { personId: 'b', score: 1 }], [{ personId: 'a', score: 1 }, { personId: 'b', score: 1 }]];
    expect(assignWithCapacity(c, () => 1)).toEqual(assignWithCapacity(c, () => 1));
  });

  it('leaves an item without a successor when everyone who fits is full', () => {
    const c = [[{ personId: 'a', score: 1 }], [{ personId: 'a', score: 0.5 }]];
    expect(assignWithCapacity(c, () => 1)).toEqual(['a', null]);
  });
});

describe('plan with a per-person limit', () => {
  const req = { leaverId: 'priya', from: NOW, to: NOW + 14 * 86_400_000 };
  it('never gives anyone more than the limit', () => {
    const plan = buildHandoverPlan(fixtureOrg, req, { maxPerPerson: 2 });
    const counts = new Map<string, number>();
    for (const grp of plan.groups) for (const e of grp.entries) if (e.successor) counts.set(e.successor.personId, (counts.get(e.successor.personId) ?? 0) + 1);
    expect(counts.size).toBeGreaterThan(0);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(2);
  });
  it('leaves behaviour unchanged when no limit is set', () => {
    const a = buildHandoverPlan(fixtureOrg, req);
    const b = buildHandoverPlan(fixtureOrg, req, { maxPerPerson: undefined });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
