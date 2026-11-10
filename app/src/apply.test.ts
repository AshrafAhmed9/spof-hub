import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { applyPlan, undoPlan, type ApplyDeps } from './apply';
import { buildHandoverPlan, type Graph } from './engine';
import { memoryStore } from './kv';
import { makeHandlers } from './resolvers';
import type { Deps } from './service';
import type { OpRecord } from './types';

const NOW = Date.UTC(2026, 5, 1);
const DAY = 86_400_000;

// Dana holds ABC-1 and ABC-2 (unassigned to her on ABC-2). Sam and Lee are alternatives.
const graph: Graph = {
  people: [
    { id: 'dana', name: 'Dana', team: 'core' },
    { id: 'sam', name: 'Sam', team: 'core' },
    { id: 'lee', name: 'Lee', team: 'core' },
  ],
  items: [
    { id: 'ABC-1', kind: 'workItem', title: 'Billing export', area: 'billing', open: true, priority: 'high' },
    { id: 'ABC-2', kind: 'workItem', title: 'Invoice retries', area: 'billing', open: true, priority: 'high' },
    { id: 'page:9', kind: 'page', title: 'Runbook', area: 'Space OPS', open: true, priority: 'high' },
  ],
  edges: [
    ...['ABC-1', 'ABC-2', 'page:9'].flatMap((item) => [
      { person: 'dana', item, kind: 'commented' as const, at: NOW - 3 * DAY, weight: 1 },
      { person: 'dana', item, kind: 'commented' as const, at: NOW - 5 * DAY, weight: 1 },
      { person: 'dana', item, kind: 'authored' as const, at: NOW - 9 * DAY, weight: 1 },
      { person: 'sam', item, kind: 'commented' as const, at: NOW - 20 * DAY, weight: 0.3 },
    ]),
    { person: 'lee', item: 'ABC-1', kind: 'commented', at: NOW - 30 * DAY, weight: 0.2 },
  ],
};

/** A tiny Jira: assignee, comments and watchers per issue, with call counters and failure injection. */
function fakeJira() {
  const state = {
    assignee: { 'ABC-1': 'dana', 'ABC-2': null } as Record<string, string | null>,
    comments: {} as Record<string, Array<{ id: string; body: unknown }>>,
    watchers: {} as Record<string, string[]>,
    puts: 0,
    commentPosts: 0,
    watcherPosts: 0,
    failNext: new Set<string>(), // e.g. 'comment', 'assignee'
    seq: 0,
  };
  const res = (status: number, body: unknown = {}) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
  const client: any = {
    async requestJira(route: any, init: any = {}) {
      const path: string = typeof route === 'string' ? route : route.value;
      const method = init.method ?? 'GET';
      const m = /\/issue\/([A-Z]+-\d+)(\/[a-z]+)?(?:\/([^/?]+))?/.exec(path);
      if (!m) return res(404);
      const key = m[1]!;
      const sub = m[2];
      if (!sub && method === 'GET') return res(200, { fields: { assignee: state.assignee[key] ? { accountId: state.assignee[key] } : null } });
      if (sub === '/assignee' && method === 'PUT') {
        if (state.failNext.delete('assignee')) return res(500, { err: 'jira down' });
        state.puts++;
        state.assignee[key] = JSON.parse(init.body).accountId;
        return res(204);
      }
      if (sub === '/comment' && method === 'POST') {
        if (state.failNext.delete('comment')) return res(403, { err: 'no permission' });
        state.commentPosts++;
        const id = String(++state.seq);
        (state.comments[key] ??= []).push({ id, body: JSON.parse(init.body).body });
        return res(201, { id });
      }
      if (sub === '/comment' && method === 'GET') return res(200, { comments: state.comments[key] ?? [] });
      if (sub === '/comment' && method === 'DELETE') {
        state.comments[key] = (state.comments[key] ?? []).filter((c) => c.id !== m[3]);
        return res(204);
      }
      if (sub === '/watchers' && method === 'GET') return res(200, { watchers: (state.watchers[key] ?? []).map((accountId) => ({ accountId })) });
      if (sub === '/watchers' && method === 'POST') {
        state.watcherPosts++;
        (state.watchers[key] ??= []).push(JSON.parse(init.body));
        return res(204);
      }
      if (sub === '/watchers' && method === 'DELETE') {
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

async function setup() {
  const store = memoryStore();
  const jira = fakeJira();
  const plan = buildHandoverPlan(graph, { leaverId: 'dana', from: NOW, to: NOW + 14 * DAY });
  await store.set(`plan:${plan.planKey}`, plan);
  const deps: ApplyDeps = { api: jira.api, store, now: () => NOW, retry: { sleep: async () => {} } };
  const entries = plan.groups.flatMap((g) => g.entries);
  return { store, jira, plan, deps, entries, e1: entries.find((e) => e.itemId === 'ABC-1')!, e2: entries.find((e) => e.itemId === 'ABC-2')!, page: entries.find((e) => e.itemId === 'page:9')! };
}

describe('applyPlan idempotency', () => {
  it('plans a successor for the work items', async () => {
    const { e1, e2 } = await setup();
    expect(e1.successor).not.toBeNull();
    expect(e2.successor).not.toBeNull();
  });

  it('applies reassign + comment + watcher once; a repeat call changes nothing', async () => {
    const { deps, plan, jira, e1 } = await setup();
    const first = await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(first.failed).toEqual([]);
    expect(first.done).toEqual([{ operationKey: e1.operationKey, itemId: 'ABC-1' }]);
    expect(jira.state.assignee['ABC-1']).toBe(e1.successor!.personId);
    expect(jira.state.comments['ABC-1']).toHaveLength(1);
    expect(jira.state.watchers['ABC-1']).toEqual([e1.successor!.personId]);

    const again = await applyPlan(deps, plan.planKey, [e1.operationKey, e1.operationKey]);
    expect(again.done).toHaveLength(1);
    expect(jira.state.puts).toBe(1);
    expect(jira.state.commentPosts).toBe(1);
    expect(jira.state.watcherPosts).toBe(1);
  });

  it('returns failures with a reason, keeps finished steps, and a retry resumes without repeating them', async () => {
    const { deps, plan, jira, e1, store } = await setup();
    jira.state.failNext.add('comment');
    const r1 = await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(r1.done).toEqual([]);
    expect(r1.failed).toHaveLength(1);
    expect(r1.failed[0]!.reason).toMatch(/commenting failed\. You do not have permission/);
    expect(jira.state.puts).toBe(1); // assignee step finished
    expect((await store.get<OpRecord>(`op:${e1.operationKey}`))!.status).toBe('failed');

    const r2 = await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(r2.failed).toEqual([]);
    expect(jira.state.puts).toBe(1); // not repeated
    expect(jira.state.commentPosts).toBe(1);
    expect(jira.state.watcherPosts).toBe(1);
  });

  it('finds a comment that posted but was not recorded instead of posting twice', async () => {
    const { deps, plan, jira, e1, store } = await setup();
    // Simulate a crash after the POST: pending marker saved, comment exists in Jira.
    await store.set(`op:${e1.operationKey}`, {
      operationKey: e1.operationKey, planKey: plan.planKey, itemId: 'ABC-1', toAccountId: e1.successor!.personId, toName: 'x',
      status: 'applying', at: NOW, steps: { assignee: { prev: 'dana', now: e1.successor!.personId }, comment: { pending: true } },
    } satisfies OpRecord);
    jira.state.assignee['ABC-1'] = e1.successor!.personId;
    jira.state.comments['ABC-1'] = [{ id: '77', body: `... [ref ${e1.operationKey}]` }];
    const r = await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(r.failed).toEqual([]);
    expect(jira.state.commentPosts).toBe(0);
    expect((await store.get<OpRecord>(`op:${e1.operationKey}`))!.steps.comment!.id).toBe('77');
  });

  it('reports pages, unknown keys, and missing plans as failures', async () => {
    const { deps, plan, page } = await setup();
    const r = await applyPlan(deps, plan.planKey, [page.operationKey, 'op_nope']);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.reason).join('|')).toMatch(/only supported for Jira work items/);
    expect(r.failed.map((f) => f.reason).join('|')).toMatch(/not part of this plan/);
    const missing = await applyPlan(deps, 'plan_missing', ['x']);
    expect(missing.failed[0]!.reason).toMatch(/not found/);
  });

  it('does not add a watcher who already watches, and undo leaves that watcher alone', async () => {
    const { deps, plan, jira, e1 } = await setup();
    jira.state.watchers['ABC-1'] = [e1.successor!.personId];
    await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(jira.state.watcherPosts).toBe(0);
    await undoPlan(deps, plan.planKey);
    expect(jira.state.watchers['ABC-1']).toEqual([e1.successor!.personId]);
  });
});

describe('suggestions the site would refuse', () => {
  it('skips a candidate who cannot be assigned in the project', () => {
    const open = buildHandoverPlan(graph, { leaverId: 'dana', from: NOW, to: NOW + 14 * DAY });
    const pick = open.groups.flatMap((g) => g.entries).find((e) => e.itemId === 'ABC-1')!.successor!.personId;
    const limited = buildHandoverPlan(graph, { leaverId: 'dana', from: NOW, to: NOW + 14 * DAY }, { eligible: (_item, person) => person !== pick });
    const next = limited.groups.flatMap((g) => g.entries).find((e) => e.itemId === 'ABC-1')!.successor;
    expect(next?.personId).not.toBe(pick);
  });

  it('explains a refused assignee in plain words', async () => {
    const { deps, plan, jira, e1 } = await setup();
    const orig = jira.api.asUser;
    (jira.api as any).asUser = () => ({
      ...orig(),
      requestJira: async (r: any, init: any) => {
        const path = typeof r === 'string' ? r : r.value;
        if (/assignee/.test(path) && init?.method === 'PUT') {
          const body = JSON.stringify({ errorMessages: [], errors: { assignee: "User 'abc' cannot be assigned issues." } });
          return { status: 400, ok: false, json: async () => JSON.parse(body), text: async () => body };
        }
        return orig().requestJira(r, init);
      },
    });
    const r = await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(r.failed[0]!.reason).toMatch(/not allowed to take issues/);
    expect(r.failed[0]!.reason).not.toMatch(/errorMessages/);
  });
});

describe('undoPlan', () => {
  it('restores the previous assignee (including nobody), removes the comment and watcher', async () => {
    const { deps, plan, jira, e1, e2 } = await setup();
    await applyPlan(deps, plan.planKey, [e1.operationKey, e2.operationKey]);
    expect(jira.state.assignee['ABC-2']).toBe(e2.successor!.personId);

    const u = await undoPlan(deps, plan.planKey);
    expect(u).toEqual({ planKey: plan.planKey, reverted: 2, failed: [] });
    expect(jira.state.assignee['ABC-1']).toBe('dana');
    expect(jira.state.assignee['ABC-2']).toBeNull();
    expect(jira.state.comments['ABC-1']).toEqual([]);
    expect(jira.state.watchers['ABC-1']).toEqual([]);
  });

  it('is idempotent: a second undo reverts nothing and makes no calls that matter', async () => {
    const { deps, plan, jira, e1 } = await setup();
    await applyPlan(deps, plan.planKey, [e1.operationKey]);
    await undoPlan(deps, plan.planKey);
    const putsAfterFirst = jira.state.puts;
    const u = await undoPlan(deps, plan.planKey);
    expect(u.reverted).toBe(0);
    expect(jira.state.puts).toBe(putsAfterFirst);
  });

  it('refuses to overwrite an assignee someone changed after the handover', async () => {
    const { deps, plan, jira, e1 } = await setup();
    await applyPlan(deps, plan.planKey, [e1.operationKey]);
    jira.state.assignee['ABC-1'] = 'someone-else';
    const u = await undoPlan(deps, plan.planKey);
    expect(u.reverted).toBe(0);
    expect(u.failed[0]!.reason).toMatch(/Assignee changed/);
    expect(jira.state.assignee['ABC-1']).toBe('someone-else');
  });

  it('can re-apply after an undo', async () => {
    const { deps, plan, jira, e1 } = await setup();
    await applyPlan(deps, plan.planKey, [e1.operationKey]);
    await undoPlan(deps, plan.planKey);
    const r = await applyPlan(deps, plan.planKey, [e1.operationKey]);
    expect(r.done).toHaveLength(1);
    expect(jira.state.assignee['ABC-1']).toBe(e1.successor!.personId);
    expect(jira.state.comments['ABC-1']).toHaveLength(1);
  });
});

describe('sample mode never writes', () => {
  it('applyPlan/undoPlan/startScan in sample mode touch no storage, queue, or Jira', async () => {
    const store = memoryStore();
    const jira = fakeJira();
    let pushed = 0;
    const deps: Deps = {
      api: jira.api,
      store,
      queue: { push: async () => void pushed++ },
      now: () => NOW,
      sample: () => ({ graph, asOf: NOW, meta: {} }),
    };
    const h = makeHandlers(deps);
    const built = await h.buildPlan({ mode: 'sample', leaverId: 'dana', from: NOW, to: NOW + 14 * DAY });
    expect(built.mode).toBe('sample');
    expect(built.plan.totals.items).toBeGreaterThan(0);
    const keys = built.plan.groups.flatMap((g) => g.entries.map((e) => e.operationKey));
    const applied = await h.applyPlan({ mode: 'sample', planKey: built.plan.planKey, approvedOperationKeys: keys });
    expect(applied).toEqual({ planKey: built.plan.planKey, done: [], failed: [], skippedSample: true });
    await h.undoPlan({ mode: 'sample', planKey: built.plan.planKey });
    await h.startScan({ mode: 'sample' });
    await h.rescan({ mode: 'sample', planKey: built.plan.planKey });
    await h.getCoverage({ mode: 'sample' });
    expect((store as any).data.size).toBe(0);
    expect(pushed).toBe(0);
    expect(jira.state.puts + jira.state.commentPosts + jira.state.watcherPosts).toBe(0);
  });
});
