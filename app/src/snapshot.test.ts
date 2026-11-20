import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { memoryStore } from './kv';
import { runPrivacySweep } from './privacy';
import { loadGraph, type Deps } from './service';
import { CHUNK_BYTES, DELTA_LIMIT, deleteItem, loadItems, putItem, refreshSnapshot, splitChunks, writeSnapshot } from './snapshot';
import type { IndexedItem } from './types';

const NOW = Date.UTC(2026, 10, 10);

function openApi(): ApiLike {
  const client: any = {
    async requestJira(_r: any, init: any = {}) {
      const keys = [...(JSON.parse(init.body).jql as string).matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      return { status: 200, ok: true, json: async () => ({ issues: keys.map((key) => ({ id: key, key, fields: { summary: key } })), isLast: true }), text: async () => '' };
    },
  };
  return { asApp: () => client, asUser: () => client };
}

const rec = (i: number, owner = 'u1'): IndexedItem => ({
  item: { id: `P-${i}`, kind: 'workItem', title: `Item ${i}`, area: 'a', open: true },
  edges: [{ person: owner, item: `P-${i}`, kind: 'assigned', at: NOW - 1000, weight: 1 }],
  meta: { assigneeId: owner, url: `https://x.example/browse/P-${i}`, indexedAt: NOW },
});

async function site(n: number) {
  const store = memoryStore();
  await store.set('person:u1', { id: 'u1', name: 'Una One' });
  await store.set('person:u2', { id: 'u2', name: 'Uri Two' });
  for (let i = 0; i < n; i++) await store.set(`item:P-${i}`, rec(i, i % 2 ? 'u1' : 'u2'));
  const deps: Deps = { api: openApi(), store, queue: { push: async () => {} }, now: () => NOW, retry: { sleep: async () => {} }, viewerId: 'u1' };
  return { store, deps };
}

const norm = (g: { items: any[]; edges: any[]; people: any[] }) => ({
  items: [...g.items].sort((a, b) => (a.id < b.id ? -1 : 1)),
  edges: [...g.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  people: g.people,
});

describe('item snapshot', () => {
  it('a graph from the snapshot equals the graph from the full listing', async () => {
    const { store, deps } = await site(60);
    const first = await loadGraph(deps, 'live'); // miss: lists items and builds the snapshot
    expect(store.data.has('snap:meta')).toBe(true);
    const second = await loadGraph(deps, 'live'); // hit
    expect((await loadItems(store)).source).toBe('snapshot');
    expect(norm(second.graph)).toEqual(norm(first.graph));
    expect(first.graph.items.length).toBe(60);
  });

  it('falls back to the listing when meta is missing or a chunk is gone', async () => {
    const { store, deps } = await site(30);
    await loadGraph(deps, 'live');
    const meta: any = store.data.get('snap:meta');
    await store.del(`snap:chunk:${meta.gen}:0`);
    const l = await loadItems(store);
    expect(l.source).toBe('listing');
    expect(l.recs.length).toBe(30);
    await store.del('snap:meta');
    expect((await loadItems(store)).source).toBe('listing');
    const g = await loadGraph(deps, 'live');
    expect(g.graph.items.length).toBe(30);
    expect((await loadItems(store)).source).toBe('snapshot');
  });

  it('applies upserts and tombstones over the snapshot', async () => {
    const { store, deps } = await site(10);
    await loadGraph(deps, 'live');
    await putItem(store, 'P-3', { ...rec(3), item: { ...rec(3).item, title: 'Changed' } }, NOW + 1);
    await putItem(store, 'P-99', rec(99), NOW + 1);
    await deleteItem(store, 'P-4', NOW + 1);
    const l = await loadItems(store);
    expect(l.source).toBe('snapshot');
    expect(l.recs.length).toBe(10);
    expect(l.recs.find((r) => r.item.id === 'P-3')!.item.title).toBe('Changed');
    expect(l.recs.some((r) => r.item.id === 'P-99')).toBe(true);
    expect(l.recs.some((r) => r.item.id === 'P-4')).toBe(false);
    // Same ids as listing the item: records directly.
    const listed = (await store.list<IndexedItem>('item:')).map((r) => r.value.item.id).sort();
    expect(l.recs.map((r) => r.item.id).sort()).toEqual(listed);
  });

  it('folds many deltas into a new snapshot and removes them', async () => {
    const { store, deps } = await site(5);
    await loadGraph(deps, 'live');
    for (let i = 100; i < 100 + DELTA_LIMIT + 5; i++) await putItem(store, `P-${i}`, rec(i), NOW + 1);
    await loadGraph(deps, 'live');
    expect((await store.list('snap:delta:')).length).toBe(0);
    const l = await loadItems(store);
    expect(l.source).toBe('snapshot');
    expect(l.recs.length).toBe(5 + DELTA_LIMIT + 5);
    expect(l.deltas).toBe(0);
  });

  it('keeps a delta that was rewritten after it was read', async () => {
    const { store } = await site(3);
    await refreshSnapshot(store, NOW);
    await putItem(store, 'P-1', rec(1), NOW + 1);
    const l = await loadItems(store);
    await putItem(store, 'P-1', { ...rec(1), item: { ...rec(1).item, title: 'Newer' } }, NOW + 2);
    await writeSnapshot(store, l.recs, l.applied, NOW + 3);
    expect((await store.list('snap:delta:')).length).toBe(1);
    expect((await loadItems(store)).recs.find((r) => r.item.id === 'P-1')!.item.title).toBe('Newer');
  });

  it('keeps every chunk under the size cap with many items', async () => {
    const { store } = await site(0);
    for (let i = 0; i < 3000; i++) await store.set(`item:P-${i}`, rec(i));
    await refreshSnapshot(store, NOW);
    const meta: any = store.data.get('snap:meta');
    expect(meta.chunks).toBeGreaterThan(1);
    for (let n = 0; n < meta.chunks; n++) expect(Buffer.byteLength(JSON.stringify(store.data.get(`snap:chunk:${meta.gen}:${n}`)))).toBeLessThanOrEqual(CHUNK_BYTES);
    expect((await loadItems(store)).recs.length).toBe(3000);
    expect(splitChunks([]).length).toBe(0);
  });

  it('an erase removes the person from the snapshot and the deltas', async () => {
    const { store, deps } = await site(8);
    await loadGraph(deps, 'live');
    await putItem(store, 'P-1', rec(1, 'u2'), NOW + 1);
    await runPrivacySweep({ store, now: () => NOW, report: async () => [{ accountId: 'u2', status: 'closed' }], refresh: async () => [] });
    for (const [k, v] of store.data) if (k.startsWith('snap:')) expect(JSON.stringify(v)).not.toContain('"u2"');
    expect(store.data.has('snap:meta')).toBe(false);
    const g = await loadGraph(deps, 'live');
    expect(JSON.stringify(g.graph)).not.toContain('"u2"');
    expect(g.graph.items.length).toBe(8);
  });
});
