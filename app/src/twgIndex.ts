// Teamwork Graph -> index records, and the ablation counter.
//
// Teamwork Graph calls only work as the signed-in user (requestTeamworkGraph exists on asUser() only), so they
// cannot run in the queue consumer. `advanceTwg` is driven by the open page's scan-progress polls, after the
// REST scan has finished. Each read is stored under `twg:rec:*`; a failed read never overwrites an earlier
// record and is counted in the run state, so an error can never look like "no rows".
import type { Edge, Item, Person } from './engine';
import { getProgress, type TwgRunState } from './scan';
import { pageAri, type TwgClient, type TwgGoalNode, type TwgPullRequest, type TwgRows, type TwgWorkNode } from './twgClient';
import type { Deps } from './service';
import type { IndexedItem } from './types';
import type { TeamworkGraphLift } from '../shared/contract';

export const MAX_USERS = 25;
export const MAX_PAGES = 40;
const MAX_FAILURE_TEXT = 8;

/** Weights. `linked` is deliberately small: the work query does not say how the person relates to the item. */
const W = { linked: 0.2, prAuthor: 0.8, prReview: 0.6, goalOwner: 1, pageContributor: 0.6, pageOwner: 1 };

export interface TwgRecord {
  /** Account that made the read. Teamwork Graph rows are permission-filtered for this person only. */
  readBy: string | null;
  at: number;
  items: Item[];
  edges: Edge[];
  people: Person[];
}

const recKey = (kind: string, id: string, part: string) => `twg:rec:${kind}:${id}:${part}`;
const person = (u?: { accountId: string; name?: string }): Person[] => (u ? [{ id: u.accountId, name: u.name ?? u.accountId }] : []);
const pageIdOf = (n: TwgWorkNode) => n.pageId ?? /page\/(\d+)/.exec(n.id ?? '')?.[1];

// ---- Pure record builders ----

export function workRecord(rows: TwgWorkNode[], accountId: string, now: number, readBy: string | null): TwgRecord {
  const items = new Map<string, Item>();
  const edges: Edge[] = [];
  for (const n of rows) {
    let id: string | undefined;
    if (n.type === 'JiraWorkItem' && n.key) {
      id = n.key;
      items.set(id, { id, kind: 'workItem', title: n.title ?? n.key, area: n.key.split('-')[0], open: n.statusCategory !== 'done' });
    } else if (n.type === 'ConfluencePage') {
      const pid = pageIdOf(n);
      if (!pid) continue;
      id = `page:${pid}`;
      items.set(id, { id, kind: 'page', title: n.title ?? id, area: 'Confluence', open: true });
    }
    // The work query mixes many relationship types and does not say which one applies, so the edge is `linked`.
    if (id) edges.push({ person: accountId, item: id, kind: 'linked', at: now, weight: W.linked });
  }
  return { readBy, at: now, items: [...items.values()], edges, people: [] };
}

export function pullRecord(rows: TwgPullRequest[], now: number, readBy: string | null): TwgRecord {
  const items: Item[] = [];
  const edges: Edge[] = [];
  const people: Person[] = [];
  for (const pr of rows) {
    const id = `pr:${pr.id}`;
    const at = Number.isFinite(Date.parse(pr.createdAt ?? '')) ? Date.parse(pr.createdAt!) : now;
    items.push({ id, kind: 'pr', title: pr.title ?? id, area: 'Pull requests', open: pr.status === 'OPEN' || pr.status === 'DRAFT' });
    if (pr.author) {
      edges.push({ person: pr.author.accountId, item: id, kind: 'authored', at, weight: W.prAuthor });
      people.push(...person(pr.author));
    }
    for (const r of pr.reviewers) {
      people.push(...person(r.user));
      // UNAPPROVED only means "was asked"; it is not evidence of review work.
      if (r.approvalStatus === 'APPROVED' || r.approvalStatus === 'NEEDSWORK') {
        edges.push({ person: r.user.accountId, item: id, kind: 'reviewed', at: now, weight: W.prReview });
      }
    }
  }
  return { readBy, at: now, items, edges, people };
}

/** Only the explicit `owner` field becomes an edge. "Contributes to / viewed / favorited" cannot be told apart from the rows. */
export function goalRecord(rows: TwgGoalNode[], now: number, readBy: string | null): TwgRecord {
  const items: Item[] = [];
  const edges: Edge[] = [];
  const people: Person[] = [];
  for (const g of rows) {
    const id = `goal:${g.id}`;
    items.push({ id, kind: 'goal', title: g.name ?? id, area: g.type === 'AtlassianProject' ? 'Projects' : 'Goals', open: g.archived !== true });
    if (g.owner) {
      edges.push({ person: g.owner.accountId, item: id, kind: 'owns', at: now, weight: W.goalOwner });
      people.push(...person(g.owner));
    }
  }
  return { readBy, at: now, items, edges, people };
}

export function pageRecord(pageItemId: string, contributors: Array<{ accountId: string; name?: string }>, owners: Array<{ accountId: string; name?: string }>, now: number, readBy: string | null): TwgRecord {
  const edges: Edge[] = [
    ...contributors.map((u) => ({ person: u.accountId, item: pageItemId, kind: 'authored' as const, at: now, weight: W.pageContributor })),
    ...owners.map((u) => ({ person: u.accountId, item: pageItemId, kind: 'owns' as const, at: now, weight: W.pageOwner })),
  ];
  return { readBy, at: now, items: [], edges, people: [...contributors, ...owners].flatMap((u) => person(u)) };
}

// ---- Reading ----

const stateKey = (runId: string) => `twg:run:${runId}`;

/**
 * Reads Teamwork Graph for the people and pages the REST scan found. Safe to call on every progress poll:
 * it does nothing until the REST scan is done, resumes where it stopped, and stops when its time budget is spent.
 */
export async function advanceTwg(deps: Deps, budgetMs = 12_000): Promise<void> {
  if (!deps.twg) return;
  const run = await deps.store.get<{ runId: string }>('scan:run');
  if (!run) return;
  let st = await deps.store.get<TwgRunState>(stateKey(run.runId));
  if (!st) {
    if ((await getProgress(deps)).state !== 'done') return;
    st = await initState(deps);
    await deps.store.set(stateKey(run.runId), st);
  }
  const twg = deps.twg();
  const start = Date.now();
  while (!st.done && Date.now() - start < budgetMs) {
    const task = st.tasks[st.next]!;
    const failures = task.k === 'u' ? await readUser(deps, twg, task.id) : await readPage(deps, twg, task.id);
    st.next++;
    if (failures.length) {
      st.failed += failures.length;
      for (const f of failures) if (st.failures.length < MAX_FAILURE_TEXT) st.failures.push(f);
    }
    st.done = st.next >= st.tasks.length;
    await deps.store.set(stateKey(run.runId), st);
  }
}

async function initState(deps: Deps): Promise<TwgRunState> {
  const recs = await deps.store.list<IndexedItem>('item:');
  const activity = new Map<string, number>();
  for (const r of recs) for (const e of r.value.edges) activity.set(e.person, (activity.get(e.person) ?? 0) + 1);
  const people = (await deps.store.list<Person>('person:')).map((p) => p.value).filter((p) => !p.isBot && p.active !== false);
  const users = people.sort((a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1)).slice(0, MAX_USERS);
  const pages = recs.filter((r) => r.value.item.kind === 'page').slice(0, MAX_PAGES);
  const tasks: TwgRunState['tasks'] = [...users.map((u) => ({ k: 'u' as const, id: u.id })), ...pages.map((p) => ({ k: 'p' as const, id: p.value.item.id.slice(5) }))];
  const failures: string[] = [];
  let failed = 0;
  if (pages.length && !deps.cloudId) {
    failed++;
    failures.push('page reads skipped: the site id was not available');
    tasks.splice(users.length);
  }
  const capped = recs.filter((r) => r.value.item.kind === 'page').length > MAX_PAGES || people.length > MAX_USERS;
  if (capped) failures.push(`Teamwork Graph reads are capped at ${MAX_USERS} people and ${MAX_PAGES} pages`);
  return { tasks, next: 0, failed, failures, done: tasks.length === 0 };
}

/** Runs the queries; stores each successful one; returns one text per failed query. */
async function readUser(deps: Deps, twg: TwgClient, id: string): Promise<string[]> {
  const now = deps.now();
  const by = deps.viewerId ?? null;
  const out: string[] = [];
  const who = (await deps.store.get<Person>(`person:${id}`))?.name ?? 'one person';
  const parts: Array<[string, () => Promise<TwgRows<any>>, (rows: any[]) => TwgRecord]> = [
    ['work', () => twg.atlassianUserWorkQuery(id), (r) => workRecord(r, id, now, by)],
    ['pulls', () => twg.atlassianUserPullRequests(id), (r) => pullRecord(r, now, by)],
    ['goals', () => twg.atlassianUserGoalsAndProjects(id), (r) => goalRecord(r, now, by)],
  ];
  for (const [part, read, build] of parts) {
    const r = await read();
    // A partial read (failed on a later page) is a failure; keep the older record rather than a truncated one.
    if (!r.ok || !r.complete) out.push(`${part} for ${who}: ${r.notes[0] ?? 'incomplete'}`);
    else await deps.store.set(recKey('u', id, part), build(r.rows));
  }
  return out;
}

async function readPage(deps: Deps, twg: TwgClient, pageId: string): Promise<string[]> {
  const ari = pageAri(deps.cloudId!, pageId);
  const [c, o] = [await twg.confluencePageContributors(ari), await twg.confluencePageOwners(ari)];
  const out: string[] = [];
  if (!c.ok || !c.complete) out.push(`contributors of page ${pageId}: ${c.notes[0] ?? 'incomplete'}`);
  if (!o.ok || !o.complete) out.push(`owners of page ${pageId}: ${o.notes[0] ?? 'incomplete'}`);
  // Contributors and owners are stored together; write only when both reads are whole.
  if (!out.length) await deps.store.set(recKey('p', pageId, 'who'), pageRecord(`page:${pageId}`, c.rows, o.rows, deps.now(), deps.viewerId ?? null));
  return out;
}

// ---- Merging into the graph, and the ablation ----

export interface MergedTwg {
  /** Items to add (not in the REST index), as index records without edges. */
  items: IndexedItem[];
  edges: Edge[];
  people: Person[];
  /** Pre-visibility ids of Jira keys / pages that need the per-viewer REST permission check. */
  needsCheck: string[];
  hasRecords: boolean;
  withheld: number;
}

const pairKey = (e: Edge) => `${e.person}|${e.item}`;
const edgeKey = (e: Edge) => `${e.person}|${e.item}|${e.kind}`;

/** True when REST already supplies this link. `linked` is satisfied by any REST edge on the pair. */
function coveredByRest(restKeys: Set<string>, restPairs: Set<string>, e: Edge) {
  return e.kind === 'linked' ? restPairs.has(pairKey(e)) : restKeys.has(edgeKey(e));
}

export async function mergeTwg(deps: Pick<Deps, 'store' | 'viewerId' | 'now'>, rest: IndexedItem[]): Promise<MergedTwg> {
  const recs = (await deps.store.list<TwgRecord>('twg:rec:')).map((r) => r.value);
  const restIds = new Set(rest.map((r) => r.item.id));
  const restKeys = new Set<string>();
  const restPairs = new Set<string>();
  for (const r of rest) for (const e of r.edges) { restKeys.add(edgeKey(e)); restPairs.add(pairKey(e)); }

  const items = new Map<string, IndexedItem>();
  const edges = new Map<string, Edge>();
  const people = new Map<string, Person>();
  let withheld = 0;
  for (const rec of recs) {
    // PRs and goals have no REST permission check here. They are shown only to the person whose read produced them.
    const mine = rec.readBy !== null && rec.readBy === deps.viewerId;
    const guarded = rec.items.some((i) => i.kind === 'pr' || i.kind === 'goal');
    if (guarded && !mine) { withheld++; continue; }
    for (const i of rec.items) if (!restIds.has(i.id) && !items.has(i.id)) items.set(i.id, { item: i, edges: [], meta: { indexedAt: rec.at } });
    for (const e of rec.edges) {
      if (coveredByRest(restKeys, restPairs, e)) continue;
      edges.set(edgeKey(e), e);
    }
    for (const p of rec.people) people.set(p.id, { ...people.get(p.id), ...p });
  }
  const needsCheck = [...items.values()].map((r) => r.item).filter((i) => i.kind === 'workItem' || i.kind === 'page').map((i) => i.id);
  return { items: [...items.values()], edges: [...edges.values()], people: [...people.values()], needsCheck, hasRecords: recs.length > 0, withheld };
}

/** Counts what survived visibility and pruning and exists only because of Teamwork Graph. */
export function liftOf(merged: MergedTwg, keptItemIds: Set<string>): TeamworkGraphLift {
  const items: Record<string, number> = {};
  const edgeKinds: Record<string, number> = {};
  let itemsN = 0;
  let edgesN = 0;
  for (const r of merged.items) {
    if (!keptItemIds.has(r.item.id)) continue;
    itemsN++;
    items[r.item.kind] = (items[r.item.kind] ?? 0) + 1;
  }
  for (const e of merged.edges) {
    if (!keptItemIds.has(e.item)) continue;
    edgesN++;
    edgeKinds[e.kind] = (edgeKinds[e.kind] ?? 0) + 1;
  }
  return { itemsOnlyFromGraph: itemsN, edgesOnlyFromGraph: edgesN, byKind: { items, edges: edgeKinds }, withheldRecords: merged.withheld };
}
