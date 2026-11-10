import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { memoryStore } from './kv';
import { clearCoverageCache, coverage, setupStatus, type Deps } from './service';
import { getProgress } from './scan';
import { TwgClient } from './twgClient';
import { advanceTwg, goalRecord, pageRecord, pullRecord, workRecord, type TwgRecord } from './twgIndex';
import type { IndexedItem } from './types';

const NOW = Date.UTC(2026, 10, 1);
const fast = { sleep: async () => {}, maxRetries: 0 };
const res = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
const conn = (field: string, nodes: any[]) => ({ data: { [field]: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } } } });

/** Fake site. `twg` maps a root field to a reply; `visible` lists Jira keys / page ids the viewer can read. */
function fakeApi(twg: Record<string, unknown>, visible: { keys: string[]; pages: string[] } = { keys: [], pages: [] }): ApiLike {
  const client: any = {
    async requestTeamworkGraph(query: string) {
      const field = Object.keys(twg).find((f) => query.includes(`${f}(`));
      if (!field) return res(200, { errors: [{ message: 'unexpected query' }], data: null });
      return res(200, twg[field]);
    },
    async requestJira(route: any, init: any = {}) {
      if (String(route.value).startsWith('/rest/api/3/search/jql')) {
        const asked = [...JSON.parse(init.body).jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        return res(200, { issues: asked.filter((k) => visible.keys.includes(k)).map((key) => ({ key })), isLast: true });
      }
      return res(200, {});
    },
    async requestConfluence() {
      return res(200, { results: visible.pages.map((id) => ({ id })) });
    },
  };
  return { asUser: () => client, asApp: () => client };
}

const restIssue = (key: string, person: string, kind: 'assigned' | 'commented' = 'assigned'): IndexedItem => ({
  item: { id: key, kind: 'workItem', title: key, area: 'ABC', open: true },
  edges: [{ person, item: key, kind, at: NOW - 1000, weight: 1 }],
  meta: { indexedAt: NOW },
});

describe('record builders', () => {
  it('work query becomes weak `linked` edges and skips unknown node types', () => {
    const rec = workRecord(
      [
        { type: 'JiraWorkItem', key: 'ABC-1', title: 'One', statusCategory: 'done' },
        { type: 'ConfluencePage', id: 'ari:cloud:confluence:s:page/42', title: 'Doc' },
        { type: 'Other', id: 'x' },
      ],
      'u1',
      NOW,
      'v',
    );
    expect(rec.items.map((i) => [i.id, i.kind, i.open])).toEqual([['ABC-1', 'workItem', false], ['page:42', 'page', true]]);
    expect(rec.edges.every((e) => e.kind === 'linked' && e.person === 'u1')).toBe(true);
    expect(rec.edges).toHaveLength(2);
  });

  it('PRs: author authored, only decided reviewers reviewed', () => {
    const rec = pullRecord(
      [{ id: 'p1', title: 'Fix', status: 'OPEN', author: { accountId: 'a', name: 'Ann' }, reviewers: [{ user: { accountId: 'b' }, approvalStatus: 'APPROVED' }, { user: { accountId: 'c' }, approvalStatus: 'UNAPPROVED' }] }],
      NOW,
      'v',
    );
    expect(rec.items[0]).toMatchObject({ id: 'pr:p1', kind: 'pr', open: true });
    expect(rec.edges.map((e) => [e.person, e.kind])).toEqual([['a', 'authored'], ['b', 'reviewed']]);
  });

  it('goals: only the explicit owner gets an edge; archived is closed', () => {
    const rec = goalRecord([{ type: 'AtlassianGoal', id: 'g1', name: 'Ship', owner: { accountId: 'o' } }, { type: 'AtlassianProject', id: 'pj', name: 'Old', archived: true }], NOW, 'v');
    expect(rec.edges).toHaveLength(1);
    expect(rec.edges[0]).toMatchObject({ person: 'o', item: 'goal:g1', kind: 'owns' });
    expect(rec.items.map((i) => i.open)).toEqual([true, false]);
  });

  it('page record maps contributors and owners', () => {
    const rec = pageRecord('page:7', [{ accountId: 'c' }], [{ accountId: 'o' }], NOW, 'v');
    expect(rec.edges.map((e) => e.kind)).toEqual(['authored', 'owns']);
  });
});

describe('advanceTwg', () => {
  async function seeded() {
    const store = memoryStore();
    await store.set('scan:run', { runId: 'r1', startedAt: Date.now(), projectKeys: [], includePages: false });
    await store.set('scan:list:r1:jira', { done: true, chunks: 0, items: 0 });
    await store.set('person:u1', { id: 'u1', name: 'Una' });
    await store.set('item:ABC-1', restIssue('ABC-1', 'u1'));
    return store;
  }
  const depsOf = (store: ReturnType<typeof memoryStore>, api: ApiLike, extra: Partial<Deps> = {}): Deps => ({
    api,
    store,
    queue: { push: async () => {} },
    now: () => NOW,
    twg: () => new TwgClient(api, fast),
    viewerId: 'viewer',
    cloudId: 'site',
    ...extra,
  });

  it('stores records for each query and reports completion', async () => {
    const store = await seeded();
    const api = fakeApi({
      atlassianUserWorkQuery: conn('atlassianUserWorkQuery', [{ __typename: 'JiraWorkItem', key: 'ABC-9', summary: 'Nine', status: { statusCategory: { key: 'new' } } }]),
      atlassianUserPullRequests: conn('atlassianUserPullRequests', []),
      atlassianUserGoalsAndProjects: conn('atlassianUserGoalsAndProjects', [{ __typename: 'AtlassianGoal', id: 'g1', name: 'Goal', owner: { accountId: 'u1', name: 'Una' } }]),
    });
    const deps = depsOf(store, api);
    expect((await getProgress(deps)).state).toBe('done'); // REST done before the Teamwork Graph step is queued
    await advanceTwg(deps);
    const p = await getProgress(deps);
    expect(p).toMatchObject({ state: 'done', twg: { done: 1, total: 1, failed: 0 } });
    expect((await store.list('twg:rec:')).map((r) => r.key).sort()).toEqual(['twg:rec:u:u1:goals', 'twg:rec:u:u1:pulls', 'twg:rec:u:u1:work']);
  });

  it('a failed query is recorded as a failure, writes nothing, and is not an empty result', async () => {
    const store = await seeded();
    const api = fakeApi({
      atlassianUserWorkQuery: { errors: [{ message: 'Cannot query field "summary"', extensions: { classification: 'ValidationError' } }], data: null },
      atlassianUserPullRequests: conn('atlassianUserPullRequests', []),
      atlassianUserGoalsAndProjects: conn('atlassianUserGoalsAndProjects', []),
    });
    const deps = depsOf(store, api);
    await getProgress(deps);
    await advanceTwg(deps);
    const p = await getProgress(deps);
    expect(p.twg?.failed).toBe(1);
    expect(p.message).toMatch(/1 Teamwork Graph reads failed.*incomplete, not empty.*work for u1/);
    expect((await store.list('twg:rec:')).some((r) => r.key.endsWith(':work'))).toBe(false);
  });

  it('keeps the earlier record when a later read fails', async () => {
    const store = await seeded();
    const old: TwgRecord = { readBy: 'viewer', at: 1, items: [], edges: [], people: [] };
    await store.set('twg:rec:u:u1:work', old);
    const api = fakeApi({
      atlassianUserWorkQuery: { errors: [{ message: 'boom' }], data: null },
      atlassianUserPullRequests: conn('atlassianUserPullRequests', []),
      atlassianUserGoalsAndProjects: conn('atlassianUserGoalsAndProjects', []),
    });
    await getProgress(depsOf(store, api));
    await advanceTwg(depsOf(store, api));
    expect(await store.get('twg:rec:u:u1:work')).toEqual(old);
  });

  it('does nothing before the REST scan is done and without a twg client', async () => {
    const store = await seeded();
    await store.set('scan:list:r1:jira', { done: false, chunks: 1, items: 1 });
    const api = fakeApi({});
    await advanceTwg(depsOf(store, api));
    expect(await store.get('twg:run:r1')).toBeUndefined();
    const { twg: _t, ...noTwg } = depsOf(store, api);
    await advanceTwg(noTwg as Deps);
    expect(await store.get('twg:run:r1')).toBeUndefined();
  });

  it('page reads are skipped and recorded as a failure when the site id is missing', async () => {
    const store = await seeded();
    await store.set('item:page:5', { item: { id: 'page:5', kind: 'page', title: 'P', open: true }, edges: [], meta: { indexedAt: NOW } });
    const api = fakeApi({
      atlassianUserWorkQuery: conn('atlassianUserWorkQuery', []),
      atlassianUserPullRequests: conn('atlassianUserPullRequests', []),
      atlassianUserGoalsAndProjects: conn('atlassianUserGoalsAndProjects', []),
    });
    const deps = depsOf(store, api, { cloudId: undefined });
    await getProgress(deps);
    await advanceTwg(deps);
    const p = await getProgress(deps);
    expect(p.twg?.failed).toBe(1);
    expect(p.message).toMatch(/site id/);
  });
});

describe('ablation counter', () => {
  async function site(viewer: string) {
    const store = memoryStore();
    await store.set('person:u1', { id: 'u1', name: 'Una' });
    await store.set('person:u2', { id: 'u2', name: 'Ola' });
    await store.set('item:ABC-1', restIssue('ABC-1', 'u1'));
    const rec = (r: Partial<TwgRecord>): TwgRecord => ({ readBy: 'reader', at: NOW, items: [], edges: [], people: [], ...r });
    // u1 already assigned on ABC-1 by REST, so this `linked` edge adds nothing. u2 on ABC-1 is new.
    await store.set('twg:rec:u:u1:work', rec({ edges: [{ person: 'u1', item: 'ABC-1', kind: 'linked', at: NOW, weight: 0.2 }] }));
    await store.set('twg:rec:u:u2:work', rec({ edges: [{ person: 'u2', item: 'ABC-1', kind: 'linked', at: NOW, weight: 0.2 }] }));
    // A work item REST never indexed, plus a PR.
    await store.set('twg:rec:u:u2:work2', rec({ items: [{ id: 'ABC-7', kind: 'workItem', title: 'Seven', area: 'ABC', open: true }], edges: [{ person: 'u2', item: 'ABC-7', kind: 'linked', at: NOW, weight: 0.2 }] }));
    await store.set('twg:rec:u:u2:pulls', pullRecord([{ id: 'p1', title: 'PR', status: 'OPEN', author: { accountId: 'u2' }, reviewers: [{ user: { accountId: 'u1' }, approvalStatus: 'APPROVED' }] }], NOW, 'reader'));
    const api = fakeApi({}, { keys: ['ABC-1', 'ABC-7'], pages: [] });
    const deps: Deps = { api, store, queue: { push: async () => {} }, now: () => NOW, viewerId: viewer };
    return deps;
  }

  it('counts only items and links REST does not supply, for the person whose read produced them', async () => {
    const c = await coverage(await site('reader'), 'live');
    const { ablation, ...counts } = c.teamworkGraph!;
    expect(counts).toEqual({
      itemsOnlyFromGraph: 2, // ABC-7 and the PR
      edgesOnlyFromGraph: 4, // u2->ABC-1, u2->ABC-7, u2 authored PR, u1 reviewed PR
      byKind: { items: { workItem: 1, pr: 1 }, edges: { linked: 2, authored: 1, reviewed: 1 } },
      withheldRecords: 0,
    });
    // The ablation counts the same site twice. Adding Teamwork Graph adds the PR and ABC-7 to what was scanned.
    expect(ablation!.withGraph.itemsScanned).toBeGreaterThan(ablation!.restOnly.itemsScanned);
    expect(ablation!.restOnly.itemsScanned).toBe(c.totals.itemsScanned - 2);
  });

  it('withholds PR records from another viewer and says so', async () => {
    const c = await coverage(await site('someone-else'), 'live');
    expect(c.teamworkGraph?.withheldRecords).toBe(1);
    expect(c.teamworkGraph?.byKind.items).toEqual({ workItem: 1 });
    expect(c.notes.join(' ')).toMatch(/left out/);
  });

  it('leaves the field out when Teamwork Graph never produced records', async () => {
    const store = memoryStore();
    await store.set('item:ABC-1', restIssue('ABC-1', 'u1'));
    const c = await coverage({ api: fakeApi({}, { keys: ['ABC-1'], pages: [] }), store, queue: { push: async () => {} }, now: () => NOW }, 'live');
    expect(c.teamworkGraph).toBeUndefined();
  });

  it('drops a Teamwork Graph work item the viewer cannot read in Jira', async () => {
    const deps = await site('reader');
    (deps as any).api = fakeApi({}, { keys: ['ABC-1'], pages: [] });
    const c = await coverage(deps, 'live');
    expect(c.teamworkGraph?.byKind.items).toEqual({ pr: 1 });
  });
});

describe('coverage cache', () => {
  it('serves a repeat read from the cache until it is cleared or forced fresh', async () => {
    const store = memoryStore();
    await store.set('item:ABC-1', restIssue('ABC-1', 'u1'));
    let t = NOW;
    const deps: Deps = { api: fakeApi({}, { keys: ['ABC-1'], pages: [] }), store, queue: { push: async () => {} }, now: () => t, viewerId: 'u1' };
    const a = await coverage(deps, 'live');
    expect(a.totals.itemsScanned).toBe(1);
    await store.set('item:ABC-2', restIssue('ABC-2', 'u1'));
    expect((await coverage(deps, 'live')).totals.itemsScanned).toBe(1); // cached
    t += 6 * 60_000;
    expect((await coverage(deps, 'live')).generatedAt).toBe(t); // expired, rebuilt
    await clearCoverageCache(deps);
    expect((await store.list('cov:')).length).toBe(0);
    expect((await coverage(deps, 'live', true)).totals.itemsScanned).toBeGreaterThanOrEqual(1);
  });
});

describe('setup status', () => {
  it('reports Rovo and MCP as unknown, not ok', async () => {
    const store = memoryStore();
    const s = await setupStatus({ api: fakeApi({}), store, queue: { push: async () => {} }, now: () => NOW }, 'live');
    for (const id of ['rovo', 'mcp']) {
      expect(s.checks.find((c) => c.id === id)).toMatchObject({ ok: false, status: 'unknown' });
    }
  });
});

describe('issue panel knowledge', () => {
  const rec = (n: number): IndexedItem => ({
    item: { id: 'ABC-1', kind: 'workItem', title: 'T', open: true, area: 'ABC' } as any,
    edges: Array.from({ length: n }, (_, i) => ({ person: 'u1', item: 'ABC-1', kind: 'commented', at: NOW - i * 1000, weight: 1 })) as any,
    meta: { indexedAt: NOW },
  });
  const depsFor = async (n: number, visible = true): Promise<Deps> => {
    const store = memoryStore();
    await store.set('item:ABC-1', rec(n));
    await store.set('person:u1', { id: 'u1', name: 'Dana' });
    return { api: fakeApi({}, { keys: visible ? ['ABC-1'] : [], pages: [] }), store, queue: { push: async () => {} }, now: () => NOW };
  };
  it('reports the holder and single-point status from that one record', async () => {
    const { issueKnowledge } = await import('./service');
    const k = await issueKnowledge(await depsFor(4), 'ABC-1');
    expect(k).toMatchObject({ state: 'ok', holder: { name: 'Dana', share: 1 }, contributions: 4, singlePoint: true });
  });
  it('does not call a barely touched issue a single point', async () => {
    const { issueKnowledge } = await import('./service');
    expect((await issueKnowledge(await depsFor(1), 'ABC-1')).singlePoint).toBe(false);
  });
  it('says so when the issue is not indexed, and hides one the viewer cannot see', async () => {
    const { issueKnowledge } = await import('./service');
    expect((await issueKnowledge(await depsFor(4), 'ABC-9')).state).toBe('not-indexed');
    expect((await issueKnowledge(await depsFor(4, false), 'ABC-1')).state).toBe('hidden');
  });
});
