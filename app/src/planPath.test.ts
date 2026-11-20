import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { memoryStore } from './kv';
import { buildPlanFor, type Deps } from './service';
import type { IndexedItem } from './types';

const NOW = Date.UTC(2026, 10, 10);
const DAY = 86_400_000;

function openApi(): ApiLike {
  const client: any = {
    async requestJira(route: any, init: any = {}) {
      const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body, text: async () => '' });
      if (String(route.value).includes('/user/assignable/search')) return ok([]);
      const keys = [...(JSON.parse(init.body).jql as string).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      return ok({ issues: keys.map((key) => ({ id: key, key, fields: { summary: key } })), isLast: true });
    },
  };
  return { asApp: () => client, asUser: () => client };
}

/** 2,000 items over 10 projects, 40 people; "max" holds about a third of them. */
async function bigSite() {
  const store = memoryStore();
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let p = 0; p < 40; p++) await store.set(`person:u${p}`, { id: `u${p}`, name: p === 0 ? 'Max Taylor' : `Person ${p}` });
  for (let i = 0; i < 2000; i++) {
    const key = `P${i % 10}-${i}`;
    const owner = rnd() < 0.35 ? 0 : Math.floor(rnd() * 40);
    const edges = Array.from({ length: 4 }, (_, j) => ({ person: `u${j < 3 ? owner : Math.floor(rnd() * 40)}`, item: key, kind: j === 0 ? 'assigned' : 'commented', at: NOW - (j + 1) * DAY, weight: 1 }));
    const rec: IndexedItem = { item: { id: key, kind: 'workItem', title: key, area: `P${i % 10}`, open: true }, edges: edges as any, meta: { assigneeId: `u${owner}`, indexedAt: NOW } };
    await store.set(`item:${key}`, rec);
  }
  const lists: string[] = [];
  const counted = { ...store, list: (async (prefix: string, max?: number) => { lists.push(prefix); return store.list(prefix, max); }) as typeof store.list };
  const deps: Deps = { api: openApi(), store: counted, queue: { push: async () => {} }, now: () => NOW, retry: { sleep: async () => {} }, viewerId: 'u0' };
  return { deps, lists };
}

describe('Find what needs cover on a 2,000-item index', () => {
  it('reads each key prefix once and finishes well inside the 25 s limit', async () => {
    const { deps, lists } = await bigSite();
    const t = Date.now();
    const res = await buildPlanFor(deps, 'live', { leaverId: 'u0', from: NOW, to: NOW + 14 * DAY }, { persist: false });
    const ms = Date.now() - t;
    expect(res.plan.totals.items).toBeGreaterThan(300);
    expect([...lists].sort()).toEqual(['item:', 'person:', 'snap:delta:', 'twg:rec:']);
    expect(ms).toBeLessThan(10_000);
  });
});
