import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { filterVisible } from './adapters';

const ids = Array.from({ length: 2050 }, (_, i) => `P-${i}`);

function api(hidden: (k: string) => boolean, failBatchContaining?: string): { api: ApiLike; peak: () => number; calls: () => number } {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const client: any = {
    async requestJira(_r: any, init: any) {
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      const jql = JSON.parse(init.body).jql as string;
      if (failBatchContaining && jql.includes(`"${failBatchContaining}"`)) return { status: 500, ok: false, json: async () => ({}), text: async () => 'boom' };
      const keys = [...jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((k) => !hidden(k));
      return { status: 200, ok: true, json: async () => ({ issues: keys.map((key) => ({ key })), isLast: true }), text: async () => '' };
    },
  };
  return { api: { asApp: () => client, asUser: () => client }, peak: () => peak, calls: () => calls };
}

describe('filterVisible', () => {
  it('checks in batches of 100, runs them in parallel up to 10, and never admits a hidden item', async () => {
    const a = api((k) => Number(k.slice(2)) % 5 === 0);
    const r = await filterVisible(a.api, ids);
    expect(a.calls()).toBe(21);
    expect(a.peak()).toBeGreaterThan(1);
    expect(a.peak()).toBeLessThanOrEqual(10);
    expect(r.visible.size).toBe(ids.filter((k) => Number(k.slice(2)) % 5 !== 0).length);
    expect(r.visible.has('P-0')).toBe(false);
    expect(r.notes).toEqual([]);
  });

  it('leaves out the items of a failed batch and says so', async () => {
    const r = await filterVisible(api(() => false, 'P-250').api, ids);
    expect(r.visible.has('P-250')).toBe(false);
    expect(r.visible.has('P-0')).toBe(true);
    expect(r.notes[0]).toMatch(/100 items/);
  });
});
