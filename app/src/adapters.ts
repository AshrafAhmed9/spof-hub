// Jira REST, Confluence REST and Teamwork Graph rows -> engine Graph records.
import { route, withRetry, type ApiLike, type Client, type Retry } from './api';
import { type Edge, type Graph, type Item, type Person, type Priority } from './engine';
import type { IndexedItem } from './types';

export const JIRA_FIELDS = ['summary', 'status', 'assignee', 'reporter', 'priority', 'duedate', 'components', 'project', 'issuelinks', 'updated', 'created'];

const PRIORITY: Record<string, Priority> = { highest: 'highest', critical: 'highest', blocker: 'highest', high: 'high', major: 'high', medium: 'medium', low: 'low', minor: 'low', lowest: 'lowest', trivial: 'lowest' };

const W = { assigned: 1, assignedHistory: 0.7, authored: 0.5, commented: 0.5, transition: 0.3, owns: 1, pageVersion: 0.6 };

export class AdapterError extends Error {}

/** Account type 'app' (or 'customer') is not a human teammate. */
export function toPerson(u: any): Person | null {
  if (!u?.accountId) return null;
  return {
    id: u.accountId,
    name: u.displayName ?? u.accountId,
    active: u.active !== false,
    ...(u.accountType === 'app' ? { isBot: true } : {}),
  };
}

const ts = (s: string | undefined, fallback: number) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : fallback;
};

async function jget(c: Client, path: any, retry?: Retry): Promise<any> {
  const res = await withRetry(() => c.requestJira(path, { headers: { Accept: 'application/json' } }), retry);
  if (!res.ok) throw new AdapterError(`Jira ${res.status} on ${String(path).slice(0, 80)}`);
  return res.json();
}

/** Searches issues (new JQL search endpoint, token paged). */
export async function searchIssues(
  c: Client,
  jql: string,
  fields: string[],
  pageToken?: string,
  maxResults = 100,
  retry?: Retry,
): Promise<{ issues: any[]; nextPageToken?: string }> {
  const res = await withRetry(
    () =>
      c.requestJira(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jql, fields, maxResults, ...(pageToken ? { nextPageToken: pageToken } : {}) }),
      }),
    retry,
  );
  if (!res.ok) throw new AdapterError(`Jira search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { issues: j.issues ?? [], ...(j.nextPageToken && !j.isLast ? { nextPageToken: j.nextPageToken } : {}) };
}

export async function fetchComments(c: Client, key: string, retry?: Retry): Promise<any[]> {
  const j = await jget(c, route`/rest/api/3/issue/${key}/comment?maxResults=100&orderBy=-created`, retry);
  return j.comments ?? [];
}

export async function fetchChangelog(c: Client, key: string, maxPages = 3, retry?: Retry): Promise<any[]> {
  const out: any[] = [];
  for (let p = 0; p < maxPages; p++) {
    const j = await jget(c, route`/rest/api/3/issue/${key}/changelog?startAt=${p * 100}&maxResults=100`, retry);
    out.push(...(j.values ?? []));
    if (j.isLast !== false || !(j.values ?? []).length) break;
  }
  return out;
}

export interface BuiltIssue { record: IndexedItem; people: Person[] }

/** Pure: Jira issue + comments + changelog -> engine item and edges. */
export function buildIssueRecord(issue: any, comments: any[], changelog: any[], now: number, siteUrl?: string): BuiltIssue {
  const f = issue.fields ?? {};
  const people = new Map<string, Person>();
  const add = (u: any) => {
    const p = toPerson(u);
    if (p) people.set(p.id, { ...people.get(p.id), ...p });
    return p;
  };
  const key: string = issue.key;
  const updated = ts(f.updated, now);
  const edges: Edge[] = [];

  const assignee = add(f.assignee);
  if (assignee) edges.push({ person: assignee.id, item: key, kind: 'assigned', at: updated, weight: W.assigned });
  const reporter = add(f.reporter);
  if (reporter) edges.push({ person: reporter.id, item: key, kind: 'authored', at: ts(f.created, updated), weight: W.authored });
  for (const c of comments) {
    const a = add(c.author);
    if (a) edges.push({ person: a.id, item: key, kind: 'commented', at: ts(c.created, updated), weight: W.commented });
  }
  for (const h of changelog) {
    const a = add(h.author);
    if (!a) continue;
    const at = ts(h.created, updated);
    for (const it of h.items ?? []) {
      if (it.field === 'assignee' && it.to) {
        // Historic assignees: we only have the account id, no name, so the person record may stay nameless.
        if (!people.has(it.to)) people.set(it.to, { id: it.to, name: it.toString ?? it.to });
        edges.push({ person: it.to, item: key, kind: 'assigned', at, weight: W.assignedHistory });
      } else if (it.field === 'status') {
        edges.push({ person: a.id, item: key, kind: 'commented', at, weight: W.transition });
      }
    }
  }

  const blocks: string[] = [];
  const links: string[] = [];
  for (const l of f.issuelinks ?? []) {
    if (l.outwardIssue?.key) (l.type?.name === 'Blocks' ? blocks : links).push(l.outwardIssue.key);
    else if (l.inwardIssue?.key) links.push(l.inwardIssue.key);
  }
  const prio = PRIORITY[String(f.priority?.name ?? '').toLowerCase()];
  const due = f.duedate ? Date.parse(`${f.duedate}T12:00:00Z`) : NaN;
  const item: Item = {
    id: key,
    kind: 'workItem',
    title: f.summary ?? key,
    area: f.components?.[0]?.name ?? f.project?.key,
    ...(prio ? { priority: prio } : {}),
    ...(Number.isFinite(due) ? { dueAt: due } : {}),
    open: f.status?.statusCategory?.key !== 'done',
    ...(blocks.length ? { blocks } : {}),
    ...(links.length ? { links } : {}),
  };
  return {
    record: {
      item,
      edges,
      meta: { ...(siteUrl ? { url: `${siteUrl}/browse/${key}` } : {}), assigneeId: assignee?.id ?? null, indexedAt: now },
    },
    people: [...people.values()],
  };
}

export async function indexIssue(c: Client, issue: any, now: number, siteUrl?: string, retry?: Retry): Promise<BuiltIssue> {
  const [comments, changelog] = await Promise.all([fetchComments(c, issue.key, retry), fetchChangelog(c, issue.key, 3, retry)]);
  return buildIssueRecord(issue, comments, changelog, now, siteUrl);
}

/** Looks up display names for account ids the index does not know yet. */
export async function lookupPeople(c: Client, ids: string[], retry?: Retry): Promise<Person[]> {
  const out: Person[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams();
    for (const id of ids.slice(i, i + 50)) q.append('accountId', id);
    const j = await jget(c, route`/rest/api/3/user/bulk?${q}`, retry);
    for (const u of j.values ?? []) {
      const p = toPerson(u);
      if (p) out.push(p);
    }
  }
  return out;
}

// ---- Visibility (per-user permission filtering) ----

export interface VisibleResult { visible: Set<string>; notes: string[] }

/**
 * Index data is written as the app, which can see more than the viewer. Before showing or planning on
 * items, keep only those the viewing user can read. Fails closed: if a check fails, those items are dropped
 * and a note says so.
 */
export async function filterVisible(api: ApiLike, itemIds: string[], retry?: Retry): Promise<VisibleResult> {
  const visible = new Set<string>();
  const notes: string[] = [];
  const user = api.asUser();
  // Pages (Teamwork Graph only) cannot be permission-checked without Confluence access, so they are never shown.
  const issues = itemIds.filter((i) => !i.startsWith('page:'));
  // Batches run a few at a time; one after another took ~25 s on a 4,600-item index.
  const inBatches = async (ids: string[], run: (batch: string[]) => Promise<void>): Promise<number> => {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
    let failed = 0;
    for (let i = 0; i < batches.length; i += 6) {
      await Promise.all(batches.slice(i, i + 6).map((b) => run(b).catch(() => { failed += b.length; })));
    }
    return failed;
  };
  const issueFailed = await inBatches(issues, async (batch) => {
    const keys = batch.map((k) => `"${k.replace(/"/g, '')}"`).join(',');
    const r = await searchIssues(user, `key in (${keys})`, ['summary'], undefined, 100, retry);
    for (const x of r.issues) visible.add(x.key);
  });
  if (issueFailed) notes.push(`Could not check Jira permissions for ${issueFailed} items; they were left out.`);
  return { visible, notes };
}

// ---- Graph assembly ----

export function assembleGraph(records: IndexedItem[], people: Person[]): Graph {
  const byId = new Map(people.map((p) => [p.id, p]));
  const items: Item[] = [];
  const edges: Edge[] = [];
  for (const r of records) {
    items.push(r.item);
    edges.push(...r.edges);
    for (const e of r.edges) if (!byId.has(e.person)) byId.set(e.person, { id: e.person, name: e.person });
  }
  return { people: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), items, edges };
}

/** Keeps only blocks/links that point at items still in the graph, so the engine sees no dangling ids. */
export function pruneGraph(g: Graph, keepItem: (id: string) => boolean): Graph {
  const items = g.items
    .filter((i) => keepItem(i.id))
    .map((i) => ({
      ...i,
      ...(i.blocks ? { blocks: i.blocks.filter(keepItem) } : {}),
      ...(i.links ? { links: i.links.filter(keepItem) } : {}),
    }));
  const ids = new Set(items.map((i) => i.id));
  return { people: g.people, items, edges: g.edges.filter((e) => ids.has(e.item)) };
}
