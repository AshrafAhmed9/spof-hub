import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { applyPlan, undoPlan, type ApplyDeps } from './apply';
import { buildHandoverPlan, type Graph } from './engine';
import { memoryStore } from './kv';
import { runPrivacySweep } from './privacy';
import { makeHandlers } from './resolvers';
import { listRuns, type Deps } from './service';
import type { OpRecord } from './types';

const NOW = Date.UTC(2026, 10, 21);
const DAY = 86_400_000;

const graph: Graph = {
  people: [{ id: 'dana', name: 'Dana' }, { id: 'sam', name: 'Sam' }],
  items: ['ABC-1', 'ABC-2', 'ABC-3'].map((id) => ({ id, kind: 'workItem' as const, title: id, area: 'billing', open: true, priority: 'high' as const })),
  edges: ['ABC-1', 'ABC-2', 'ABC-3'].flatMap((item) => [
    { person: 'dana', item, kind: 'commented' as const, at: NOW - 3 * DAY, weight: 1 },
    { person: 'dana', item, kind: 'authored' as const, at: NOW - 9 * DAY, weight: 1 },
    { person: 'sam', item, kind: 'commented' as const, at: NOW - 20 * DAY, weight: 0.3 },
  ]),
};

const res = (status: number, body: unknown = {}) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
const client: any = {
  async requestJira(route: any, init: any = {}) {
    const path: string = typeof route === 'string' ? route : route.value;
    const m = init.method ?? 'GET';
    if (m === 'POST' && path.endsWith('/comment')) return res(201, { id: 'c1' });
    if (m === 'GET' && path.endsWith('/watchers')) return res(200, { watchers: [] });
    if (m === 'GET' && /\/issue\/[A-Z]+-\d+\?/.test(path)) return res(200, { fields: { assignee: { accountId: 'dana' } } });
    return res(204);
  },
};
const api: ApiLike = { asUser: () => client, asApp: () => client };

async function setup() {
  const store = memoryStore();
  const plan = buildHandoverPlan(graph, { leaverId: 'dana', from: NOW, to: NOW + 14 * DAY });
  await store.set(`plan:${plan.planKey}`, plan);
  const deps: ApplyDeps = { api, store, now: () => NOW, retry: { sleep: async () => {} } };
  const keys = plan.groups.flatMap((g) => g.entries.map((e) => e.operationKey));
  return { store, plan, deps, keys, lst: { ...deps, queue: { push: async () => {} } } as Deps };
}

describe('listRuns', () => {
  it('lists a run applied in two batches once, and flips to undone when the undo finishes', async () => {
    const { deps, plan, keys, lst } = await setup();
    await applyPlan(deps, plan.planKey, keys.slice(0, 2));
    await applyPlan(deps, plan.planKey, keys.slice(1)); // overlaps: the repeat must not count twice
    const [run] = await listRuns(lst, 'live');
    expect(run).toEqual({ planKey: plan.planKey, leaverName: 'Dana', at: NOW, done: keys.length, failed: 0, undone: false });

    await undoPlan(deps, plan.planKey, { cursor: 0, limit: 1 });
    expect((await listRuns(lst, 'live'))[0]!.undone).toBe(false);
    await undoPlan(deps, plan.planKey);
    expect((await listRuns(lst, 'live'))[0]!.undone).toBe(true);

    await applyPlan(deps, plan.planKey, keys.slice(0, 1)); // applying again reopens it
    expect((await listRuns(lst, 'live'))[0]!.undone).toBe(false);
  });

  it('finds a run applied before summaries existed, from planops and the op records', async () => {
    const { store, plan, lst } = await setup();
    const ops = ['a', 'b'];
    for (const [i, k] of ops.entries()) {
      const op: OpRecord = { operationKey: k, planKey: plan.planKey, itemId: `ABC-${i + 1}`, toAccountId: 'sam', toName: 'Sam', status: 'done', at: NOW - i, steps: { assignee: { prev: 'dana', now: 'sam' } } };
      await store.set(`op:${k}`, op);
    }
    await store.set(`planops:${plan.planKey}`, ops);
    expect(await listRuns(lst, 'live')).toEqual([{ planKey: plan.planKey, leaverName: 'Dana', at: NOW, done: 2, failed: 0, undone: false }]);
  });

  it('returns the newest 20, and nothing in sample mode', async () => {
    const { store, lst } = await setup();
    for (let i = 0; i < 25; i++) await store.set(`run:p${i}`, { planKey: `p${i}`, leaverId: 'dana', leaverName: 'Dana', from: 0, to: 1, at: i, doneKeys: ['x'], failedKeys: [], undone: false });
    const runs = await listRuns(lst, 'live');
    expect(runs).toHaveLength(20);
    expect(runs[0]!.planKey).toBe('p24');
    expect(await listRuns(lst, 'sample')).toEqual([]);
    expect(await makeHandlers(lst).listRuns({ mode: 'sample' })).toEqual([]);
  });

  it('is erased with the leaver: a closed account drops the run summary and the name', async () => {
    const { store, deps, plan, keys, lst } = await setup();
    await applyPlan(deps, plan.planKey, keys);
    expect(await store.list('run:')).toHaveLength(1);
    const reported: string[] = [];
    await runPrivacySweep({
      store,
      now: () => NOW,
      report: async (a) => { reported.push(...a.map((x) => x.accountId)); return a.filter((x) => x.accountId === 'dana').map((x) => ({ accountId: x.accountId, status: 'closed' as const })); },
      refresh: async () => [],
    });
    expect(reported).toContain('dana');
    expect(await store.list('run:')).toHaveLength(0);
    expect(JSON.stringify([...(store as any).data.values()])).not.toContain('Dana');
    // The ops are still there, so the run stays listed and undoable under a neutral name.
    const [run] = await listRuns(lst, 'live');
    expect(run!.leaverName).toBe('Unknown person');
  });
});
