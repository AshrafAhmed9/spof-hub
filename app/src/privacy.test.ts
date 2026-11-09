import { describe, expect, it } from 'vitest';
import { memoryStore } from './kv';
import { runPrivacySweep, TOMBSTONE_ID, TOMBSTONE_NAME, type Account, type AccountUpdate } from './privacy';

const NOW = Date.UTC(2026, 10, 1);

async function seeded() {
  const store = memoryStore();
  await store.set('person:dana', { id: 'dana', name: 'Dana Fox', fetchedAt: '2026-10-01T00:00:00.000Z' });
  await store.set('person:sam', { id: 'sam', name: 'Sam Lee' });
  await store.set('item:ABC-1', {
    item: { id: 'ABC-1', kind: 'issue', title: 'Billing', open: true },
    edges: [{ person: 'dana', item: 'ABC-1', kind: 'assigned', at: 1, weight: 1 }, { person: 'sam', item: 'ABC-1', kind: 'commented', at: 2, weight: 1 }],
    meta: { assigneeId: 'dana', indexedAt: 3 },
  });
  await store.set('twg:rec:u:dana:work', { readBy: 'sam', at: 1, items: [], edges: [{ person: 'dana', item: 'ABC-1', kind: 'linked', at: 1, weight: 1 }], people: [{ id: 'dana', name: 'Dana Fox' }] });
  await store.set('op:k1', { operationKey: 'k1', toAccountId: 'dana', toName: 'Dana Fox', steps: { assignee: { prev: 'sam', now: 'dana' } }, status: 'done' });
  await store.set('plan:p1', { planKey: 'p1', leaverId: 'dana', leaverName: 'Dana Fox' });
  await store.set('plan:p2', { planKey: 'p2', leaverId: 'sam', leaverName: 'Sam Lee' });
  return store;
}

function deps(store: Awaited<ReturnType<typeof seeded>>, updates: AccountUpdate[], extra: Partial<Parameters<typeof runPrivacySweep>[0]> = {}) {
  const calls: Account[][] = [];
  return {
    calls,
    d: {
      store,
      now: () => NOW,
      report: async (a: Account[]) => { calls.push(a); return updates; },
      refresh: async () => [],
      ...extra,
    },
  };
}

describe('privacy sweep', () => {
  it('reports every stored id once, with the fetch time or the epoch', async () => {
    const store = await seeded();
    const { d, calls } = deps(store, []);
    await runPrivacySweep(d);
    const byId = Object.fromEntries(calls[0]!.map((a) => [a.accountId, a.updatedAt]));
    expect(Object.keys(byId).sort()).toEqual(['dana', 'sam']);
    expect(byId.dana).toBe('2026-10-01T00:00:00.000Z');
    expect(byId.sam).toBe(new Date(0).toISOString());
  });

  it('erases a closed account from person, items, graph reads, ops and plans', async () => {
    const store = await seeded();
    const { d } = deps(store, [{ accountId: 'dana', status: 'closed' }]);
    const r = await runPrivacySweep(d);
    expect(r.closed).toEqual(['dana']);
    expect(await store.get('person:dana')).toBeUndefined();
    expect(await store.get('person:sam')).toBeDefined();
    expect(await store.get('plan:p1')).toBeUndefined();
    expect(await store.get('plan:p2')).toBeDefined();
    const all = JSON.stringify([...store.data.values()]);
    expect(all).not.toContain('dana');
    expect(all).not.toContain('Dana Fox');
    const item: any = await store.get('item:ABC-1');
    expect(item.edges.map((e: any) => e.person)).toEqual([TOMBSTONE_ID, 'sam']);
    expect(item.meta.assigneeId).toBe(TOMBSTONE_ID);
    const op: any = await store.get('op:k1');
    expect(op.toName).toBe(TOMBSTONE_NAME);
    expect(op.steps.assignee).toEqual({ prev: 'sam', now: TOMBSTONE_ID });
    const rec: any = await store.get('twg:rec:u:dana:work');
    expect(rec.readBy).toBe('sam');
    expect(rec.people[0].name).toBe(TOMBSTONE_NAME);
  });

  it('never reports the tombstone on the next cycle', async () => {
    const store = await seeded();
    await runPrivacySweep(deps(store, [{ accountId: 'dana', status: 'closed' }]).d);
    const { d, calls } = deps(store, []);
    await runPrivacySweep(d);
    expect(calls[0]!.map((a) => a.accountId)).toEqual(['sam']);
  });

  it('refreshes an updated account and stamps its fetch time', async () => {
    const store = await seeded();
    const { d } = deps(store, [{ accountId: 'sam', status: 'updated' }], { refresh: async () => [{ id: 'sam', name: 'Samuel Lee' }] });
    const r = await runPrivacySweep(d);
    expect(r.refreshed).toEqual(['sam']);
    expect(await store.get('person:sam')).toEqual({ id: 'sam', name: 'Samuel Lee', fetchedAt: new Date(NOW).toISOString() });
  });

  it('throws when the report call fails and erases nothing', async () => {
    const store = await seeded();
    const before = JSON.stringify([...store.data.entries()]);
    const { d } = deps(store, [], { report: async () => { throw new Error('HTTP 503'); } });
    await expect(runPrivacySweep(d)).rejects.toThrow('HTTP 503');
    expect(JSON.stringify([...store.data.entries()])).toBe(before);
  });

  it('throws when an updated account is not returned by the lookup, and still erases closed ones', async () => {
    const store = await seeded();
    const { d } = deps(store, [{ accountId: 'dana', status: 'closed' }, { accountId: 'sam', status: 'updated' }]);
    await expect(runPrivacySweep(d)).rejects.toThrow(/not returned/);
    expect(await store.get('person:dana')).toBeUndefined();
  });

  it('throws on a refresh failure and on ids it cannot report', async () => {
    const store = await seeded();
    await store.set('person:unknown', { id: 'unknown', name: 'x' });
    const { d, calls } = deps(store, [{ accountId: 'sam', status: 'updated' }], { refresh: async () => { throw new Error('HTTP 500'); } });
    await expect(runPrivacySweep(d)).rejects.toThrow(/refresh failed.*HTTP 500.*could not be reported/);
    expect(calls[0]!.map((a) => a.accountId)).not.toContain('unknown');
  });

  it('does nothing and calls nothing on an empty store', async () => {
    const { d, calls } = deps(memoryStore() as any, []);
    expect(await runPrivacySweep(d)).toEqual({ reported: 0, closed: [], refreshed: [], skipped: [] });
    expect(calls).toEqual([]);
  });
});
