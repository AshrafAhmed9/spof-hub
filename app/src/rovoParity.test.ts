import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { memoryStore } from './kv';
import { coverage, type Deps } from './service';
import { run as findSinglePoints } from './rovo/findSinglePoints';
import type { IndexedItem } from './types';

const NOW = Date.UTC(2026, 10, 10);
const DAY = 86_400_000;

/** Every key is visible to the viewer. */
function openApi(): ApiLike {
  const client: any = {
    async requestJira(_r: any, init: any = {}) {
      const keys = [...(JSON.parse(init.body).jql as string).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      return { status: 200, ok: true, json: async () => ({ issues: keys.map((key) => ({ id: key, key, fields: { summary: key } })), isLast: true }), text: async () => '' };
    },
  };
  return { asApp: () => client, asUser: () => client };
}

const rec = (key: string, area: string, contributions: number): IndexedItem => ({
  item: { id: key, kind: 'workItem', title: `Item ${key}`, area, open: true },
  edges: Array.from({ length: contributions }, (_, i) => ({ person: 'max', item: key, kind: i === 0 ? 'assigned' : 'commented', at: NOW - (i + 1) * DAY, weight: 1 })) as any,
  meta: { assigneeId: 'max', indexedAt: NOW },
});

async function site() {
  const store = memoryStore();
  await store.set('person:max', { id: 'max', name: 'Max Taylor' });
  // 31 product-discovery ideas in MPLAT that only Max touched once, plus one well-worked issue in MP.
  for (let i = 1; i <= 31; i++) await store.set(`item:MPLAT-${i}`, rec(`MPLAT-${i}`, 'MPLAT', 1));
  await store.set('item:MP-2', rec('MP-2', 'MP', 4));
  const deps: Deps = { api: openApi(), store, queue: { push: async () => {} }, now: () => NOW, retry: { sleep: async () => {} }, viewerId: 'viewer' };
  return deps;
}

describe('Rovo find_single_points and the hub Coverage page agree', () => {
  it('counts the same single points per area for the same viewer', async () => {
    const deps = await site();
    const hub = await coverage(deps, 'live', true);
    const out = await findSinglePoints(deps, {});
    for (const a of hub.areas) {
      expect(out.singlePoints.filter((s) => s.area === a.area)).toHaveLength(a.singlePointItems);
    }
    expect(out.singlePoints.map((s) => s.item)).toEqual(['MP-2']);
  });

  it('explains an area the hub shows as held by one person but with no single-point items', async () => {
    const deps = await site();
    const hub = await coverage(deps, 'live', true);
    const mplat = hub.areas.find((a) => a.area === 'MPLAT')!;
    expect([mplat.items, mplat.singlePointItems, mplat.topPerson.name]).toEqual([31, 0, 'Max Taylor']);
    for (const q of ['MPLAT', 'mpl', 'mplat ']) {
      const out = await findSinglePoints(deps, { area: q });
      expect(out.count).toBe(0);
      expect(out.areas).toHaveLength(1);
      expect(out.areas[0]).toMatchObject({ area: 'MPLAT', items: 31, singlePointItems: 0, topHolder: 'Max Taylor', topHolderShare: 1 });
      expect(out.areas[0]!.note).toMatch(/Max Taylor holds 100% of this area's recorded work\. No single item meets the single-point rule \(3\+ recorded contributions with one person holding at least 80%/);
    }
  });

  it('lists the real areas when the filter matches nothing', async () => {
    const out = await findSinglePoints(await site(), { area: 'Platform' });
    expect(out.count).toBe(0);
    expect(out.notes.join(' ')).toMatch(/No area matches "Platform".*MPLAT/);
  });
});
