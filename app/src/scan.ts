// Chunked, resumable index build. startScan (user context) pushes the first events;
// the queue consumer (app context) lists keys, fans out chunk events and writes `item:` / `person:` records.
// Progress is derived from per-chunk marker keys, so concurrent consumers never fight over one counter.
import {
  buildPageRecord,
  fetchPageVersions,
  indexIssue,
  listPages,
  lookupPeople,
  searchIssues,
  spaceNames,
  JIRA_FIELDS,
} from './adapters';
import type { ApiLike, Retry } from './api';
import type { Person } from './engine';
import type { Store } from './kv';
import type { ScanProgress } from '../shared/contract';

export interface PushQueue { push(events: Array<{ body: Record<string, unknown> }>): Promise<unknown> }

export interface ScanDeps {
  api: ApiLike;
  store: Store;
  queue: PushQueue;
  now: () => number;
  siteUrl?: string;
  retry?: Retry;
}

const CHUNK = 20;
const LIST_PAGE = 100;
const HISTORY_DAYS = 365;

interface RunMeta { runId: string; startedAt: number; projectKeys: string[]; includePages: boolean }
interface ListState { done: boolean; chunks: number; items: number; error?: string }
/** Progress of the Teamwork Graph read that follows the REST scan (see twgIndex.ts). */
export interface TwgRunState {
  tasks: Array<{ k: 'u' | 'p'; id: string }>;
  next: number;
  /** Count of failed reads. Failed reads are never treated as empty results. */
  failed: number;
  failures: string[];
  done: boolean;
}
interface ChunkMarker { count: number; failed: Array<{ id: string; reason: string }> }

type ScanEvent =
  | { runId: string; kind: 'jira-list'; jql: string; token?: string }
  | { runId: string; kind: 'jira-chunk'; n: number; keys: string[] }
  | { runId: string; kind: 'pages-list'; cursor?: string; spaces?: Array<[string, string]>; n?: number }
  | { runId: string; kind: 'pages-chunk'; n: number; pages: Array<Record<string, unknown>> };

export function jqlFor(projectKeys: string[] | undefined): string {
  const proj = projectKeys?.length ? `project in (${projectKeys.map((k) => `"${k.replace(/[^A-Za-z0-9_]/g, '')}"`).join(',')}) AND ` : '';
  return `${proj}(statusCategory != Done OR updated >= -${HISTORY_DAYS}d) ORDER BY updated DESC`;
}

export async function startScan(deps: ScanDeps, req: { projectKeys?: string[]; includePages?: boolean } = {}): Promise<ScanProgress> {
  const current = await getProgress(deps);
  if (current.state === 'running') return { ...current, message: 'A scan is already running.' };
  const runId = `run_${deps.now().toString(36)}`;
  const meta: RunMeta = { runId, startedAt: deps.now(), projectKeys: req.projectKeys ?? [], includePages: req.includePages !== false };
  await deps.store.set('scan:run', meta);
  const events: Array<{ body: ScanEvent }> = [{ body: { runId, kind: 'jira-list', jql: jqlFor(req.projectKeys) } }];
  if (meta.includePages) events.push({ body: { runId, kind: 'pages-list' } });
  try {
    await deps.queue.push(events as Array<{ body: Record<string, unknown> }>);
  } catch (e) {
    await deps.store.del('scan:run'); // never leave a run that nothing will ever work on
    throw e;
  }
  return { state: 'running', done: 0, total: 0, message: 'Scan queued.' };
}

const PENDING = 'scan:pending:';
let pendingSeq = 0;

/** Tries the Forge queue first. If the platform rejects the push, events wait in app storage and `pumpScan` runs them. */
export function withStoreFallback(primary: PushQueue, store: Pick<ScanDeps['store'], 'set' | 'get'>, now: () => number): PushQueue {
  return {
    async push(events) {
      try {
        return await primary.push(events);
      } catch (e) {
        console.warn('queue push failed, using stored work list:', String((e as Error).message));
        await store.set('scan:fallback', true);
        for (const ev of events) {
          const key = `${PENDING}${String(now()).padStart(15, '0')}:${String(pendingSeq++).padStart(6, '0')}`;
          await store.set(key, ev.body);
        }
        return undefined;
      }
    },
  };
}

/** Runs stored events for up to `budgetMs`. Called from progress polls while the page is open. */
export async function pumpScan(deps: ScanDeps, budgetMs = 15_000, parallel = 4): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const pending = (await deps.store.list<ScanEvent>(PENDING)).sort((a, b) => (a.key < b.key ? -1 : 1));
    if (!pending.length) return;
    const batch = pending.slice(0, parallel);
    // Delete first so a second open tab does not repeat the work; an unfinished chunk shows as an unfinished scan.
    await Promise.all(batch.map((e) => deps.store.del(e.key)));
    await Promise.all(batch.map((e) => handleScanEvent(deps, e.value).catch((err) => console.warn('scan event failed', String(err)))));
  }
}

export async function hasPending(deps: Pick<ScanDeps, 'store'>): Promise<boolean> {
  return (await deps.store.list(PENDING)).length > 0;
}

export async function getProgress(deps: Pick<ScanDeps, 'store'>): Promise<ScanProgress> {
  const run = await deps.store.get<RunMeta>('scan:run');
  if (!run) return { state: 'idle', done: 0, total: 0 };
  const jira = await deps.store.get<ListState>(`scan:list:${run.runId}:jira`);
  const pages = run.includePages ? await deps.store.get<ListState>(`scan:list:${run.runId}:pages`) : { done: true, chunks: 0, items: 0 };
  const markers = await deps.store.list<ChunkMarker>(`chunk:${run.runId}:`);
  const done = markers.reduce((s, m) => s + m.value.count, 0);
  const failed = markers.flatMap((m) => m.value.failed);
  const total = (jira?.items ?? 0) + (pages?.items ?? 0);
  const planned = (jira?.chunks ?? 0) + (pages?.chunks ?? 0);
  const msgs: string[] = [];
  if (failed.length) msgs.push(`${failed.length} items could not be indexed (first: ${failed[0]!.id}: ${failed[0]!.reason})`);
  if (pages?.error) msgs.push(`Confluence skipped: ${pages.error}`);
  if (jira?.error) return { state: 'error', done, total, message: `Jira listing failed: ${jira.error}` };
  const finished = !!jira?.done && !!pages?.done && markers.length >= planned;
  // A run that never started (no listing written) or never finishes must not block a retry forever.
  const age = Date.now() - run.startedAt;
  // Stored work means the scan can still be resumed, however long the page was closed.
  const resumable = age > 45 * 60_000 ? (await deps.store.list(PENDING)).length > 0 : true;
  if (!finished && ((!jira && age > 3 * 60_000) || !resumable)) {
    return { state: 'error', done, total, message: 'The scan stalled and was stopped. Nothing was changed. You can start it again.' };
  }
  const twg = finished ? await deps.store.get<TwgRunState>(`twg:run:${run.runId}`) : undefined;
  const twgPending = !!twg && !twg.done;
  if (twg) {
    if (twgPending) msgs.push(`Reading Teamwork Graph: ${twg.next} of ${twg.tasks.length}`);
    else if (!twg.done) msgs.push('Teamwork Graph reading stopped early; its data is incomplete');
    if (twg.failed) msgs.push(`${twg.failed} Teamwork Graph reads failed, so that data is incomplete, not empty (first: ${twg.failures[0] ?? 'unknown'})`);
  }
  return {
    state: finished && !twgPending ? 'done' : 'running',
    done,
    total,
    ...(msgs.length ? { message: msgs.join('; ') } : {}),
    ...(twg ? { twg: { done: twg.next, total: twg.tasks.length, failed: twg.failed } } : {}),
  };
}

export async function handleScanEvent(deps: ScanDeps, ev: ScanEvent): Promise<void> {
  const run = await deps.store.get<RunMeta>('scan:run');
  if (!run || run.runId !== ev.runId) return; // stale event from a replaced run
  switch (ev.kind) {
    case 'jira-list':
      return jiraList(deps, ev);
    case 'jira-chunk':
      return jiraChunk(deps, ev);
    case 'pages-list':
      return pagesList(deps, ev);
    case 'pages-chunk':
      return pagesChunk(deps, ev);
  }
}

const listKey = (runId: string, w: 'jira' | 'pages') => `scan:list:${runId}:${w}`;

async function bumpList(deps: ScanDeps, runId: string, w: 'jira' | 'pages', add: Partial<ListState>) {
  // Only the single list chain of each kind writes here, so read-modify-write is safe.
  const cur = (await deps.store.get<ListState>(listKey(runId, w))) ?? { done: false, chunks: 0, items: 0 };
  await deps.store.set(listKey(runId, w), { ...cur, ...add, chunks: cur.chunks + (add.chunks ?? 0), items: cur.items + (add.items ?? 0) });
}

async function jiraList(deps: ScanDeps, ev: Extract<ScanEvent, { kind: 'jira-list' }>) {
  try {
    const page = await searchIssues(deps.api.asApp(), ev.jql, ['summary'], ev.token, LIST_PAGE, deps.retry);
    const keys = page.issues.map((i) => i.key as string);
    const chunks: Array<{ body: ScanEvent }> = [];
    const prior = (await deps.store.get<ListState>(listKey(ev.runId, 'jira')))?.chunks ?? 0;
    for (let i = 0; i < keys.length; i += CHUNK) chunks.push({ body: { runId: ev.runId, kind: 'jira-chunk', n: prior + chunks.length, keys: keys.slice(i, i + CHUNK) } });
    // Record planned chunks before pushing, so progress never reports done early.
    await bumpList(deps, ev.runId, 'jira', { chunks: chunks.length, items: keys.length, done: !page.nextPageToken });
    const next: Array<{ body: ScanEvent }> = page.nextPageToken ? [{ body: { runId: ev.runId, kind: 'jira-list', jql: ev.jql, token: page.nextPageToken } }] : [];
    const all = [...chunks, ...next];
    if (all.length) await deps.queue.push(all as Array<{ body: Record<string, unknown> }>);
  } catch (e) {
    await bumpList(deps, ev.runId, 'jira', { done: true, error: String((e as Error).message) });
  }
}

export async function indexKeys(deps: ScanDeps, keys: string[]): Promise<{ indexed: number; failed: Array<{ id: string; reason: string }> }> {
  const failed: Array<{ id: string; reason: string }> = [];
  let indexed = 0;
  const app = deps.api.asApp();
  let issues: any[] = [];
  try {
    const q = keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',');
    issues = (await searchIssues(app, `key in (${q})`, JIRA_FIELDS, undefined, 100, deps.retry)).issues;
  } catch (e) {
    return { indexed: 0, failed: keys.map((id) => ({ id, reason: String((e as Error).message) })) };
  }
  const found = new Set(issues.map((i) => i.key));
  for (const k of keys) if (!found.has(k)) failed.push({ id: k, reason: 'not found or no longer visible to the app' });
  const people = new Map<string, Person>();
  for (const issue of issues) {
    try {
      const built = await indexIssue(app, issue, deps.now(), deps.siteUrl, deps.retry);
      await deps.store.set(`item:${issue.key}`, built.record);
      for (const p of built.people) people.set(p.id, { ...people.get(p.id), ...p });
      indexed++;
    } catch (e) {
      failed.push({ id: issue.key, reason: String((e as Error).message) });
    }
  }
  await savePeople(deps, [...people.values()]);
  return { indexed, failed };
}

async function savePeople(deps: ScanDeps, people: Person[]) {
  for (const p of people) {
    const prev = await deps.store.get<Person>(`person:${p.id}`);
    // Keep a real display name over a placeholder that equals the id.
    // fetchedAt is the age of this personal data; the privacy sweep reports it to Atlassian.
    const merged = { ...prev, ...p, name: p.name !== p.id ? p.name : (prev?.name ?? p.name), fetchedAt: new Date(deps.now()).toISOString() };
    await deps.store.set(`person:${p.id}`, merged);
  }
}

async function jiraChunk(deps: ScanDeps, ev: Extract<ScanEvent, { kind: 'jira-chunk' }>) {
  const r = await indexKeys(deps, ev.keys);
  const marker: ChunkMarker = { count: ev.keys.length, failed: r.failed };
  await deps.store.set(`chunk:${ev.runId}:jira:${ev.n}`, marker);
}

async function pagesList(deps: ScanDeps, ev: Extract<ScanEvent, { kind: 'pages-list' }>) {
  try {
    const c = deps.api.asApp();
    const spaces = new Map<string, string>(ev.spaces ?? (ev.cursor ? [] : [...(await spaceNames(c, deps.retry))]));
    const page = await listPages(c, ev.cursor, deps.retry);
    const stubs = page.pages.map((p) => ({ ...p, spaceName: spaces.get(p.spaceName ?? '') ?? p.spaceName }));
    const prior = (await deps.store.get<ListState>(listKey(ev.runId, 'pages')))?.chunks ?? 0;
    const chunks: Array<{ body: ScanEvent }> = [];
    for (let i = 0; i < stubs.length; i += CHUNK) chunks.push({ body: { runId: ev.runId, kind: 'pages-chunk', n: prior + chunks.length, pages: stubs.slice(i, i + CHUNK) } });
    // Page listing is capped to 10 pages of 50 (500 pages); beyond that the scan says so.
    const pagesSeen = ev.n ?? 0;
    const more = page.next && pagesSeen < 9;
    await bumpList(deps, ev.runId, 'pages', {
      chunks: chunks.length,
      items: stubs.length,
      done: !more,
      ...(page.next && !more ? { error: 'stopped at 500 pages' } : {}),
    });
    const next: Array<{ body: ScanEvent }> = more ? [{ body: { runId: ev.runId, kind: 'pages-list', cursor: page.next!, spaces: [...spaces], n: pagesSeen + 1 } }] : [];
    const all = [...chunks, ...next];
    if (all.length) await deps.queue.push(all as Array<{ body: Record<string, unknown> }>);
  } catch (e) {
    await bumpList(deps, ev.runId, 'pages', { done: true, error: String((e as Error).message) });
  }
}

export async function indexPages(deps: ScanDeps, pages: any[]): Promise<Array<{ id: string; reason: string }>> {
  const failed: Array<{ id: string; reason: string }> = [];
  const c = deps.api.asApp();
  const peopleIds = new Set<string>();
  for (const p of pages) {
    try {
      const versions = await fetchPageVersions(c, p.id, deps.retry);
      const rec = buildPageRecord(p, versions, deps.now(), deps.siteUrl);
      for (const e of rec.edges) peopleIds.add(e.person);
      await deps.store.set(`item:${rec.item.id}`, rec);
    } catch (e) {
      failed.push({ id: `page:${p.id}`, reason: String((e as Error).message) });
    }
  }
  const unknown: string[] = [];
  for (const id of peopleIds) if (!(await deps.store.get(`person:${id}`))) unknown.push(id);
  try {
    if (unknown.length) await savePeople(deps, await lookupPeople(deps.api.asApp(), unknown, deps.retry));
  } catch (e) {
    failed.push({ id: 'people', reason: `names for ${unknown.length} people not resolved: ${(e as Error).message}` });
  }
  return failed;
}

async function pagesChunk(deps: ScanDeps, ev: Extract<ScanEvent, { kind: 'pages-chunk' }>) {
  const failed = await indexPages(deps, ev.pages);
  await deps.store.set(`chunk:${ev.runId}:pages:${ev.n}`, { count: ev.pages.length, failed } satisfies ChunkMarker);
}
