import { describe, expect, it } from 'vitest';
import type { ApiLike } from './api';
import { memoryStore } from './kv';
import { handleScanEvent, getProgress, startScan, type ScanDeps } from './scan';
import { run as handoverBrief } from './rovo/handoverBrief';

const NOW = Date.UTC(2026, 5, 1);

function fakeSite(keys: string[], failKey?: string) {
  const issue = (key: string) => ({
    id: key.replace(/\D/g, ''), key,
    fields: {
      summary: `Task ${key}`, status: { statusCategory: { key: 'indeterminate' } },
      assignee: { accountId: 'dana', displayName: 'Dana', accountType: 'atlassian', active: true },
      reporter: { accountId: 'bot1', displayName: 'Automation', accountType: 'app' },
      priority: { name: 'High' }, components: [{ name: 'billing' }], project: { key: 'ABC' },
      updated: new Date(NOW - 86_400_000).toISOString(), created: new Date(NOW - 20 * 86_400_000).toISOString(),
    },
  });
  const res = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body) });
  const client: any = {
    async requestJira(route: any, init: any = {}) {
      const path: string = route.value;
      if (path.startsWith('/rest/api/3/search/jql')) {
        const jql: string = JSON.parse(init.body).jql;
        const inList = /key in \((.*?)\)/.exec(jql);
        const wanted = inList ? inList[1]!.split(',').map((s) => s.replace(/"/g, '')) : keys;
        return res(200, { issues: wanted.filter((k) => keys.includes(k)).map(issue), isLast: true });
      }
      const k = /issue\/([A-Z]+-\d+)/.exec(path)?.[1];
      if (k && k === failKey) return res(500, {});
      if (path.includes('/comment')) return res(200, { comments: [{ author: { accountId: 'sam', displayName: 'Sam', accountType: 'atlassian' }, created: new Date(NOW - 2 * 86_400_000).toISOString() }] });
      if (path.includes('/changelog')) return res(200, { values: [], isLast: true });
      return res(404, {});
    },
    async requestConfluence() { return res(200, { results: [] }); },
  };
  return { asApp: () => client, asUser: () => client } as ApiLike;
}

async function drain(deps: ScanDeps, queue: any[]) {
  while (queue.length) await handleScanEvent(deps, queue.shift().body);
}

describe('scan', () => {
  it('lists, chunks, indexes, and reports progress to done; bots are marked', async () => {
    const keys = Array.from({ length: 45 }, (_, i) => `ABC-${i + 1}`);
    const queue: any[] = [];
    const store = memoryStore();
    const deps: ScanDeps = { api: fakeSite(keys), store, queue: { push: async (e) => void queue.push(...e) }, now: () => NOW, retry: { sleep: async () => {} } };
    const started = await startScan(deps, { includePages: false });
    expect(started.state).toBe('running');
    await drain(deps, queue);
    const p = await getProgress(deps);
    expect(p).toMatchObject({ state: 'done', done: 45, total: 45 });
    expect((await store.list('item:')).length).toBe(45);
    const bot = await store.get<any>('person:bot1');
    expect(bot.isBot).toBe(true);
  });

  it('reports per-item failures in progress instead of hiding them', async () => {
    const keys = ['ABC-1', 'ABC-2'];
    const queue: any[] = [];
    const store = memoryStore();
    const deps: ScanDeps = { api: fakeSite(keys, 'ABC-2'), store, queue: { push: async (e) => void queue.push(...e) }, now: () => NOW, retry: { sleep: async () => {} } };
    await startScan(deps, { includePages: false });
    await drain(deps, queue);
    const p = await getProgress(deps);
    expect(p.message).toMatch(/1 items could not be indexed.*ABC-2/);
    expect(await store.get('item:ABC-2')).toBeUndefined();
  });

  it('ignores events from a replaced run', async () => {
    const store = memoryStore();
    const deps: ScanDeps = { api: fakeSite([]), store, queue: { push: async () => {} }, now: () => NOW };
    await startScan(deps, { includePages: false });
    await handleScanEvent(deps, { runId: 'old', kind: 'jira-chunk', n: 0, keys: ['ABC-1'] });
    expect((await store.list('chunk:')).length).toBe(0);
  });
});

describe('rovo action on an empty index', () => {
  it('says the index is empty rather than reporting nothing at risk', async () => {
    const store = memoryStore();
    const deps = { api: fakeSite([]), store, queue: { push: async () => {} }, now: () => NOW };
    const r: any = await handoverBrief(deps as any, { person: 'Dana' });
    expect(r.error ?? '').toMatch(/No person/);
    expect(r.notes.join(' ')).toMatch(/index is empty/);
  });
});
