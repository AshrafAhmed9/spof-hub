import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { applyPlan, undoPlan, type ApplyDeps } from './apply';
import { buildHandoverPlan, type Graph } from './engine';
import { memoryStore } from './kv';
import { rescan, type Deps } from './service';
import type { OpRecord } from './types';

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;
const N = 120;
const keyOf = (i: number) => `ABC-${i + 1}`;

/** A Jira with N issues: every call is counted, and one issue can be made to fail. */
function bigJira(failOn?: string) {
  const state = {
    assignee: {} as Record<string, string | null>,
    comments: {} as Record<string, Array<{ id: string }>>,
    watchers: {} as Record<string, string[]>,
    calls: 0,
    writes: 0,
  };
  const res = (status: number, body: unknown = {}) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
  const client: any = {
    async requestJira(route: any, init: any = {}) {
      state.calls++;
      const path: string = typeof route === 'string' ? route : route.value;
      const method = init.method ?? 'GET';
      const m = /\/issue\/([A-Z]+-\d+)(\/[a-z]+)?(?:\/([^/?]+))?/.exec(path);
      if (!m) return res(404);
      const key = m[1]!;
      if (method !== 'GET') state.writes++;
      if (!m[2] && method === 'GET') return res(200, { fields: { assignee: state.assignee[key] ? { accountId: state.assignee[key] } : null } });
      if (m[2] === '/assignee' && method === 'PUT') {
        if (key === failOn) return res(500, { errorMessages: ['jira down'] });
        state.assignee[key] = JSON.parse(init.body).accountId;
        return res(204);
      }
      if (m[2] === '/comment' && method === 'DELETE') {
        state.comments[key] = (state.comments[key] ?? []).filter((c) => c.id !== m[3]);
        return res(204);
      }
      if (m[2] === '/watchers' && method === 'DELETE') {
        const acc = new URL(path, 'https://x').searchParams.get('accountId');
        state.watchers[key] = (state.watchers[key] ?? []).filter((w) => w !== acc);
        return res(204);
      }
      return res(404);
    },
  };
  const api: ApiLike = { asUser: () => client, asApp: () => client };
  return { api, state };
}

/** What a finished apply of N items leaves in storage and in Jira. */
async function appliedRun(failOn?: string) {
  const store = memoryStore();
  const jira = bigJira(failOn);
  const planKey = 'plan_big';
  const keys: string[] = [];
  for (let i = 0; i < N; i++) {
    const k = `op_${i}`;
    keys.push(k);
    const op: OpRecord = {
      operationKey: k, planKey, itemId: keyOf(i), toAccountId: 'sam', toName: 'Sam', status: 'done', at: NOW,
      steps: { assignee: { prev: i % 2 ? null : 'dana', now: 'sam' }, comment: { id: `c${i}` }, watcher: { added: true } },
    };
    await store.set(`op:${k}`, op);
    jira.state.assignee[keyOf(i)] = 'sam';
    jira.state.comments[keyOf(i)] = [{ id: `c${i}` }, { id: 'other' }];
    jira.state.watchers[keyOf(i)] = ['sam', 'pat'];
  }
  await store.set(`planops:${planKey}`, keys);
  const deps: ApplyDeps = { api: jira.api, store, now: () => NOW, retry: { sleep: async () => {} } };
  return { store, jira, deps, planKey };
}

async function undoAll(deps: ApplyDeps, planKey: string, limit: number) {
  const total = { reverted: 0, failed: [] as Array<{ itemId: string; reason: string }>, calls: 0 };
  let cursor: number | undefined;
  for (;;) {
    const r = await undoPlan(deps, planKey, { cursor, limit });
    total.calls++;
    total.reverted += r.reverted;
    total.failed.push(...r.failed);
    expect(r.reverted + r.failed.length).toBeLessThanOrEqual(limit);
    if (r.next === undefined) return total;
    expect(r.next).toBeGreaterThan(cursor ?? 0);
    cursor = r.next;
  }
}

describe('undo of a large run, in slices', () => {
  it('puts back all 120 items over several calls, as a small undo would', async () => {
    const { deps, jira, planKey, store } = await appliedRun();
    const t = await undoAll(deps, planKey, 10);
    expect(t).toMatchObject({ reverted: N, failed: [], calls: 12 });
    for (let i = 0; i < N; i++) {
      expect(jira.state.assignee[keyOf(i)]).toBe(i % 2 ? null : 'dana');
      expect(jira.state.comments[keyOf(i)]).toEqual([{ id: 'other' }]);
      expect(jira.state.watchers[keyOf(i)]).toEqual(['pat']);
      expect((await store.get<OpRecord>(`op:op_${i}`))!.status).toBe('undone');
    }
  });

  it('a slice that runs twice (a retried call) makes no second round of Jira writes', async () => {
    const { deps, jira, planKey } = await appliedRun();
    const first = await undoPlan(deps, planKey, { cursor: 0, limit: 10 });
    expect(first).toMatchObject({ reverted: 10, next: 10, total: N });
    const writes = jira.state.writes;
    const again = await undoPlan(deps, planKey, { cursor: 0, limit: 10 });
    expect(again.reverted).toBe(0);
    expect(again.failed).toEqual([]);
    expect(jira.state.writes).toBe(writes);
  });

  it('reports a failing item once, keeps going, and "undo again" finishes it', async () => {
    const { deps, jira, planKey, store } = await appliedRun('ABC-50');
    const t = await undoAll(deps, planKey, 10);
    expect(t.reverted).toBe(N - 1);
    expect(t.failed).toEqual([{ itemId: 'ABC-50', reason: expect.stringContaining('jira down') }]);
    // The watcher and comment steps were already done; only the assignee is left.
    const op = (await store.get<OpRecord>('op:op_49'))!;
    expect(op.status).toBe('done');
    expect(op.steps).toEqual({ assignee: { prev: null, now: 'sam' } });
    const fixed = bigJira();
    Object.assign(fixed.state, jira.state);
    const second = await undoAll({ ...deps, api: fixed.api }, planKey, 10);
    expect(second).toMatchObject({ reverted: 1, failed: [] });
    expect(fixed.state.assignee['ABC-50']).toBeNull();
  });

  it('stops a slice at the time budget and hands back the cursor', async () => {
    const { deps, planKey } = await appliedRun();
    const r = await undoPlan(deps, planKey, { cursor: 0, limit: 50, budgetMs: -1 });
    expect(r.reverted).toBe(1);
    expect(r.next).toBe(1);
  });

  it('without a cursor or limit it still does the whole run in one call', async () => {
    const { deps, planKey } = await appliedRun();
    const r = await undoPlan(deps, planKey);
    expect(r).toMatchObject({ reverted: N, failed: [] });
    expect(r.next).toBeUndefined();
  });
});

describe('rescan after a large run', () => {
  it('finds all 120 items and does not read them one after another', async () => {
    const people = [{ id: 'dana', name: 'Dana' }, { id: 'sam', name: 'Sam' }];
    const items = Array.from({ length: N }, (_, i) => ({ id: keyOf(i), kind: 'workItem' as const, title: `Task ${i}`, area: 'billing', open: true, priority: 'high' as const }));
    const graph: Graph = {
      people,
      items,
      edges: items.flatMap((it) => [
        { person: 'dana', item: it.id, kind: 'commented' as const, at: NOW - 3 * DAY, weight: 1 },
        { person: 'dana', item: it.id, kind: 'authored' as const, at: NOW - 9 * DAY, weight: 1 },
        { person: 'sam', item: it.id, kind: 'commented' as const, at: NOW - 20 * DAY, weight: 0.3 },
      ]),
    };
    const plan = buildHandoverPlan(graph, { leaverId: 'dana', from: NOW, to: NOW + 14 * DAY });
    const store = memoryStore();
    await store.set(`plan:${plan.planKey}`, plan);
    const stamp = new Date(NOW - DAY).toISOString();
    let searches = 0;
    let inFlight = 0;
    let peak = 0;
    const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body, text: async () => JSON.stringify(body) });
    const site: any = {
      async requestJira(r: any, init: any = {}) {
        const path: string = typeof r === 'string' ? r : r.value;
        if (path.startsWith('/rest/api/3/search/jql')) {
          searches++;
          const keys = (/key in \((.*?)\)/.exec(JSON.parse(init.body).jql)?.[1] ?? '').split(',').map((k) => k.replace(/"/g, '')).filter(Boolean);
          expect(keys.length).toBeLessThanOrEqual(100);
          return ok({ isLast: true, issues: keys.map((key) => ({ id: key.replace(/\D/g, ''), key, fields: {
            summary: `Task ${key}`, status: { statusCategory: { key: 'indeterminate' } }, priority: { name: 'High' }, components: [{ name: 'billing' }], project: { key: 'ABC' },
            assignee: { accountId: 'sam', displayName: 'sam', accountType: 'atlassian', active: true },
            reporter: { accountId: 'dana', displayName: 'Dana', accountType: 'atlassian', active: true }, updated: stamp, created: stamp } })) });
        }
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((res) => setTimeout(res, 1));
        inFlight--;
        if (/\/comment\?/.test(path)) return ok({ comments: [{ author: { accountId: 'dana', displayName: 'dana', accountType: 'atlassian' }, created: new Date(NOW - 2 * DAY).toISOString() }] });
        if (/\/changelog/.test(path)) return ok({ values: [], isLast: true });
        return ok({});
      },
    };
    const deps: Deps = { api: { asApp: () => site, asUser: () => site }, store, queue: { push: async () => {} }, now: () => NOW, retry: { sleep: async () => {} } };
    const r = await rescan(deps, 'live', plan.planKey);
    expect(r.before).toBe(N);
    expect(searches).toBeGreaterThanOrEqual(2); // 120 keys need two searches
    expect(peak).toBeGreaterThan(1);
    expect(await store.list('item:')).toHaveLength(N);
  });
});
