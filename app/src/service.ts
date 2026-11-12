// Shared logic behind resolvers and Rovo actions.
import { route } from './api';
import { applyPlan, undoPlan, type ApplyDeps } from './apply';
import { assembleGraph, filterVisible, pruneGraph } from './adapters';
import { computeCoverage, currentAssignee, MIN_EVIDENCE, SINGLE_POINT, topPerItem } from './analysis';
import { absenceTimeline, buildHandoverPlan, explainConcentration, isBot, type Graph, type HandoverPlan, type Person } from './engine';
import { indexKeys, type ScanDeps } from './scan';
import { loadSample, type SampleOrg } from './sample';
import { TwgClient } from './twgClient';
import { liftOf, mergeTwg } from './twgIndex';
import type { IndexedItem } from './types';
import type { CoverageResponse, TimelineRequest, TimelineResponse, IssueKnowledge, TeamworkGraphLift, Mode, PlanRequest, PlanResponse, RescanResult, SetupCheck, SetupStatus } from '../shared/contract';

export interface Deps extends ScanDeps {
  twg?: () => TwgClient;
  /** Account of the person using the page. Teamwork Graph rows are shown only to the person whose read produced them (PRs, goals). */
  viewerId?: string;
  /** Site id, needed to build page ARIs for Teamwork Graph. */
  cloudId?: string;
  sample?: () => SampleOrg;
}

/** Open items per person divided by this gives Person.load (capped at 1). A guess, not measured. */
export const LOAD_CAPACITY = 10;

export interface LoadedGraph {
  graph: Graph;
  now: number;
  partial: boolean;
  notes: string[];
  mode: Mode;
  /** Present when Teamwork Graph records exist for this site. */
  lift?: TeamworkGraphLift;
  /** The same graph built from Jira and Confluence records alone, for the ablation. Only when Teamwork Graph records exist. */
  restOnly?: Graph;
}

export function modeOf(payload: any): Mode {
  return payload?.mode === 'sample' ? 'sample' : 'live';
}

/** Permission results are the slow part of every live read, so they are kept per viewer for a few minutes. Cleared with the coverage cache. */
async function cachedVisible(deps: Deps, ids: string[]): Promise<{ visible: Set<string>; notes: string[] }> {
  const key = `cov:vis:${deps.viewerId ?? 'anon'}`;
  const hit = await deps.store.get<{ at: number; ids: string[]; asked: number; notes: string[] }>(key).catch(() => undefined);
  if (hit && hit.asked === ids.length && deps.now() - hit.at < COVERAGE_TTL_MS) return { visible: new Set(hit.ids), notes: hit.notes };
  const vis = await filterVisible(deps.api, ids, deps.retry);
  // A result with failed checks is not kept, so the next read tries again.
  if (vis.notes.length === 0) await deps.store.set(key, { at: deps.now(), ids: [...vis.visible], asked: ids.length, notes: vis.notes }).catch(() => undefined);
  return vis;
}

export async function loadGraph(deps: Deps, mode: Mode): Promise<LoadedGraph> {
  if (mode === 'sample') {
    const s = (deps.sample ?? (() => loadSample(deps.now())))();
    return { graph: s.graph, now: s.asOf, partial: false, notes: [], mode };
  }
  const notes: string[] = [];
  const recs = await deps.store.list<IndexedItem>('item:');
  const people = (await deps.store.list<Person>('person:')).map((p) => p.value);
  if (recs.length === 0) {
    return { graph: { people: [], items: [], edges: [] }, now: deps.now(), partial: true, notes: ['The index is empty. Open Depth Chart in Jira and run a scan. An empty result here is not evidence that nothing is at risk.'], mode };
  }
  const restRecs = recs.map((r) => r.value);
  const twg = await mergeTwg(deps, restRecs);
  // Only Jira keys and pages can be permission-checked with REST; PRs and goals are gated by viewer in mergeTwg.
  const vis = await cachedVisible(deps, [...restRecs.map((r) => r.item.id), ...twg.needsCheck]);
  notes.push(...vis.notes);
  const hidden = recs.length - restRecs.filter((r) => vis.visible.has(r.item.id)).length;
  if (hidden > 0 && vis.notes.length === 0) notes.push(`${hidden} indexed items are hidden from you by permissions and are not counted.`);
  if (twg.withheld > 0) notes.push(`${twg.withheld} Teamwork Graph records belong to another person's view and are left out.`);
  const guarded = new Set(twg.items.filter((r) => r.item.kind === 'pr' || r.item.kind === 'goal').map((r) => r.item.id));
  const keep = (id: string) => vis.visible.has(id) || guarded.has(id);
  const known = new Set(people.map((p) => p.id));
  const allPeople = [...people, ...twg.people.filter((p) => !known.has(p.id))];
  const base = assembleGraph([...restRecs, ...twg.items], allPeople);
  let graph = pruneGraph({ ...base, edges: [...base.edges, ...twg.edges] }, keep);
  // Load = open assigned items / capacity.
  const open = new Map<string, number>();
  for (const it of graph.items) {
    if (!it.open || it.kind !== 'workItem') continue;
    const a = currentAssignee(graph, it.id);
    if (a) open.set(a, (open.get(a) ?? 0) + 1);
  }
  graph = { ...graph, people: graph.people.map((p) => ({ ...p, load: Math.min(1, (open.get(p.id) ?? 0) / LOAD_CAPACITY) })) };
  const lift = twg.hasRecords ? liftOf(twg, new Set(graph.items.map((i) => i.id))) : undefined;
  const restOnly = twg.hasRecords ? pruneGraph(assembleGraph(restRecs, allPeople), keep) : undefined;
  return { graph, now: deps.now(), partial: notes.length > 0, notes, mode, ...(lift ? { lift } : {}), ...(restOnly ? { restOnly } : {}) };
}

const COVERAGE_TTL_MS = 5 * 60_000;

/**
 * Live coverage is cached per viewer for a few minutes: building it re-checks permissions on every
 * indexed item, which took ~20 s on a 5,000-item site. A new scan clears the cache (see clearCoverageCache).
 * Sample mode is cheap and never cached.
 */
export async function coverage(deps: Deps, mode: Mode, fresh = false): Promise<CoverageResponse> {
  const key = `cov:${deps.viewerId ?? 'anon'}`;
  if (mode === 'live' && !fresh) {
    const hit = await deps.store.get<{ at: number; value: CoverageResponse }>(key).catch(() => undefined);
    if (hit && deps.now() - hit.at < COVERAGE_TTL_MS) return hit.value;
  }
  const g = await loadGraph(deps, mode);
  const full = computeCoverage(g.graph, g.now);
  const teamworkGraph = g.lift && g.restOnly ? { ...g.lift, ablation: { restOnly: ablationOf(computeCoverage(g.restOnly, g.now)), withGraph: ablationOf(full) } } : g.lift;
  const value: CoverageResponse = { mode, generatedAt: g.now, partial: g.partial, notes: g.notes, ...full, ...(teamworkGraph ? { teamworkGraph } : {}) };
  // An empty index is a "run a scan" state, not a result worth keeping.
  if (mode === 'live' && value.totals.itemsScanned > 0) await deps.store.set(key, { at: deps.now(), value }).catch(() => undefined);
  return value;
}

function ablationOf(c: ReturnType<typeof computeCoverage>) {
  const { itemsScanned, singlePointItems, invisibleToAssignee } = c.totals;
  return { itemsScanned, singlePointItems, invisibleToAssignee };
}

export async function clearCoverageCache(deps: Pick<Deps, 'store'>): Promise<void> {
  const keys = await deps.store.list<unknown>('cov:');
  await Promise.all(keys.map((k) => deps.store.del(k.key)));
}

/**
 * Issue panel: one record read plus a permission check on that one key, so opening an issue costs almost nothing
 * however large the index is.
 */
export async function issueKnowledge(deps: Deps, key: string): Promise<IssueKnowledge> {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return { state: 'not-indexed', key };
  const rec = await deps.store.get<IndexedItem>(`item:${key}`);
  if (!rec) return { state: 'not-indexed', key };
  const vis = await filterVisible(deps.api, [key], deps.retry);
  if (!vis.visible.has(key)) return { state: 'hidden', key };
  const ids = [...new Set(rec.edges.map((e) => e.person))];
  const people = (await Promise.all(ids.map((id) => deps.store.get<Person>(`person:${id}`)))).filter((p): p is Person => !!p);
  const g = assembleGraph([rec], people);
  const now = deps.now();
  const top = topPerItem(g, now)[0];
  if (!top) return { state: 'ok', key, contributions: 0, singlePoint: false, indexedAt: rec.meta.indexedAt };
  const name = (id: string) => g.people.find((p) => p.id === id && p.name && p.name !== p.id)?.name ?? 'An unnamed account';
  return {
    state: 'ok',
    key,
    holder: { name: name(top.personId), share: Math.round(top.share * 100) / 100 },
    contributions: top.contributions,
    assignee: top.assignee ? name(top.assignee) : null,
    singlePoint: top.share >= SINGLE_POINT && top.contributions >= MIN_EVIDENCE,
    evidence: explainConcentration(g, key, top.personId, now).reasons.slice(0, 3),
    indexedAt: rec.meta.indexedAt,
  };
}

export function findPerson(g: Graph, text: string): { person?: Person; error?: string } {
  const t = text.trim().toLowerCase();
  const humans = g.people.filter((p) => !p.isBot && !isBot(p.name));
  const exact = humans.find((p) => p.id === text || p.name.toLowerCase() === t);
  if (exact) return { person: exact };
  const m = humans.filter((p) => p.name.toLowerCase().includes(t));
  if (m.length === 1) return { person: m[0]! };
  if (m.length === 0) return { error: `No person matching "${text}" in the scanned data.` };
  return { error: `"${text}" matches ${m.length} people: ${m.slice(0, 6).map((p) => p.name).join(', ')}. Ask which one.` };
}

/** Adds the leaver's team (and teammates') from Teamwork Graph so the successor ranking can prefer same-team people. */
async function enrichTeams(deps: Deps, g: Graph, leaverId: string, notes: string[]): Promise<Graph> {
  if (!deps.twg) return g;
  const twg = deps.twg();
  const teams = await twg.atlassianUserInTeams(leaverId);
  notes.push(...teams.notes);
  const team = teams.rows[0];
  if (!team) {
    if (teams.ok && teams.empty) notes.push('Teamwork Graph returned no team for this person (no team, or scope/permission missing); team preference was not applied.');
    return g;
  }
  const members = await twg.atlassianTeamMembers(team.id);
  notes.push(...members.notes);
  const ids = new Set(members.rows.map((m) => m.accountId));
  return { ...g, people: g.people.map((p) => (p.id === leaverId || ids.has(p.id) ? { ...p, team: team.name } : p)) };
}

export async function buildPlanFor(deps: Deps, mode: Mode, req: PlanRequest, opts: { persist?: boolean } = {}): Promise<PlanResponse> {
  const loaded = await loadGraph(deps, mode);
  const notes = [...loaded.notes];
  if (!loaded.graph.people.some((p) => p.id === req.leaverId)) notes.push(`Person ${req.leaverId} has no activity in the scanned data.`);
  const g = mode === 'live' ? await enrichTeams(deps, loaded.graph, req.leaverId, notes) : loaded.graph;
  const eligible = mode === 'live' ? await assignability(deps, g, req.leaverId, notes) : undefined;
  const cap = Number.isFinite(req.maxPerPerson) ? Math.min(100, Math.floor(req.maxPerPerson!)) : 0;
  const plan = buildHandoverPlan(g, req, { ...(eligible ? { eligible } : {}), ...(cap > 0 ? { maxPerPerson: cap } : {}) });
  if (mode === 'live' && opts.persist !== false) await deps.store.set(`plan:${plan.planKey}`, plan);
  return { plan, mode, partial: notes.length > 0, notes };
}

/**
 * Who can be assigned issues in each project the leaver worked in. A suggestion the site would refuse
 * (the person lacks the Assignable User permission) is worse than no suggestion. If a project's list
 * cannot be read, nobody is filtered out there and the note says so.
 */
async function assignability(deps: Deps, g: Graph, leaverId: string, notes: string[]): Promise<((itemId: string, personId: string) => boolean) | undefined> {
  const projects = new Set<string>();
  const mine = new Set(g.edges.filter((e) => e.person === leaverId).map((e) => e.item));
  for (const id of mine) if (/^[A-Z][A-Z0-9_]*-\d+$/.test(id)) projects.add(id.slice(0, id.lastIndexOf('-')));
  const allowed = new Map<string, Set<string>>();
  const unread: string[] = [];
  const user = deps.api.asUser();
  await Promise.all([...projects].map(async (key) => {
    try {
      const res = await user.requestJira(route`/rest/api/3/user/assignable/search?project=${key}&maxResults=1000`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      allowed.set(key, new Set(((await res.json()) as Array<{ accountId?: string }>).map((u) => u.accountId ?? '')));
    } catch {
      unread.push(key);
    }
  }));
  if (unread.length) notes.push(`Could not check who can be assigned in ${unread.sort().join(', ')}; suggestions there may not be assignable.`);
  if (allowed.size === 0) return undefined;
  return (itemId, personId) => {
    const set = allowed.get(itemId.slice(0, itemId.lastIndexOf('-')));
    return !set || set.has(personId);
  };
}

export async function rescan(deps: Deps, mode: Mode, planKey: string): Promise<RescanResult> {
  if (mode === 'sample') {
    return { planKey, remainingAtRisk: 0, before: 0 };
  }
  const plan = await deps.store.get<HandoverPlan>(`plan:${planKey}`);
  if (!plan) throw new Error(`Plan ${planKey} was not found. Build the plan again.`);
  const entries = plan.groups.flatMap((g) => g.entries);
  const keys = entries.filter((e) => e.kind === 'workItem').map((e) => e.itemId);
  const re = await indexKeys(deps, keys);
  const failedIds = new Set(re.failed.map((f) => f.id));
  // Recompute from fresh data. The leaver's history does not change, so "still at risk" means the work
  // is still on the leaver (or nobody), or the handover was never applied.
  const fresh = await buildPlanFor(deps, 'live', { leaverId: plan.leaverId, from: plan.from, to: plan.to }, { persist: false });
  let remaining = 0;
  for (const e of fresh.plan.groups.flatMap((g) => g.entries)) {
    const op = await deps.store.get<{ status: string }>(`op:${e.operationKey}`);
    const rec = await deps.store.get<IndexedItem>(`item:${e.itemId}`);
    const assignee = rec?.meta.assigneeId ?? null;
    const resolved = op?.status === 'done' && assignee !== null && assignee !== plan.leaverId && !failedIds.has(e.itemId);
    if (!resolved) remaining++;
  }
  return { planKey, remainingAtRisk: remaining, before: plan.totals.items };
}

export const apply = (deps: ApplyDeps, planKey: string, keys: string[]) => applyPlan(deps, planKey, keys);
export const undo = (deps: ApplyDeps, planKey: string) => undoPlan(deps, planKey);

export async function setupStatus(deps: Deps, mode: Mode): Promise<SetupStatus> {
  const checks: SetupCheck[] = [];
  if (mode === 'sample') {
    let detail = 'Sample data loaded. Nothing is read from or written to your site.';
    let ok = true;
    try {
      (deps.sample ?? (() => loadSample(deps.now())))();
    } catch (e) {
      ok = false;
      detail = (e as Error).message;
    }
    return {
      mode,
      checks: (['teamwork-graph', 'rovo', 'mcp', 'jira-scopes', 'index'] as const).map((id) => ({ id, ok, detail: id === 'index' ? detail : 'Not used in sample mode.' })),
    };
  }
  // Teamwork Graph
  if (deps.twg) {
    const r = await deps.twg().echo();
    checks.push({ id: 'teamwork-graph', ok: r.ok, detail: r.ok ? 'Teamwork Graph answered. Scopes are checked per query; a missing scope shows up as empty team data, not as an error.' : `Teamwork Graph call failed: ${r.error}. Check the app has the read:graph scopes granted by an org admin and that Teamwork Graph is available on this site.` });
  }
  // Rovo / MCP cannot be probed from app code.
  checks.push({ id: 'rovo', ok: false, status: 'unknown', detail: 'Not checked automatically: the agent and actions are declared in the manifest. Confirm Rovo is enabled on this site in Rovo Studio.' });
  checks.push({ id: 'mcp', ok: false, status: 'unknown', detail: 'Not checked automatically: an admin must turn the MCP tools on under Connected apps before outside clients can use them.' });
  // Jira
  try {
    const u = deps.api.asUser();
    const res = await u.requestJira(route`/rest/api/3/mypermissions?permissions=ASSIGN_ISSUES,ADD_COMMENTS,MANAGE_WATCHERS`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const perms = (await res.json()).permissions ?? {};
    const missing = ['ASSIGN_ISSUES', 'ADD_COMMENTS', 'MANAGE_WATCHERS'].filter((p) => !perms[p]?.havePermission);
    checks.push({ id: 'jira-scopes', ok: missing.length === 0, detail: missing.length ? `You lack ${missing.join(', ')} in Jira, so Apply will fail for some items. Reading works.` : 'Jira read and write checks passed for you.' });
  } catch (e) {
    checks.push({ id: 'jira-scopes', ok: false, detail: `Could not call Jira as you (${(e as Error).message}). Re-install the app and accept the Jira scopes.` });
  }
  const n = (await deps.store.list('item:', 1)).length; // one record is enough; a full listing reads the whole index
  checks.push({ id: 'index', ok: n > 0, detail: n > 0 ? 'The index has data.' : 'No data indexed yet. Run a scan.' });
  return { mode, checks };
}

export function listPeople(g: Graph): Array<{ id: string; name: string; team?: string }> {
  return g.people
    .filter((p) => p.active !== false && !p.isBot && !isBot(p.name))
    .map((p) => ({ id: p.id, name: p.name, ...(p.team ? { team: p.team } : {}) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Which areas have nobody left who knows an item, week by week, given who is away. Read-only. */
export async function timeline(deps: Deps, mode: Mode, req: TimelineRequest): Promise<TimelineResponse> {
  const weeks = Math.min(26, Math.max(1, Math.floor(req.weeks ?? 8)));
  const day = 86_400_000;
  const start = Math.floor((req.start ?? deps.now()) / day) * day;
  const loaded = await loadGraph(deps, mode);
  const known = new Set(loaded.graph.people.map((p) => p.id));
  const absences = (req.absences ?? []).filter((a) => known.has(a.personId) && Number.isFinite(a.from) && Number.isFinite(a.to) && a.to >= a.from);
  const steps = absenceTimeline(loaded.graph, absences, start, weeks, loaded.now);
  const names = new Map(loaded.graph.people.map((p) => [p.id, p.name]));
  const titles = new Map(loaded.graph.items.map((i) => [i.id, i.title]));
  return {
    mode,
    partial: loaded.partial,
    notes: loaded.notes,
    steps: steps.map((s) => ({
      start: s.start,
      end: s.end,
      absent: s.absent.map((id) => ({ id, name: names.get(id) ?? 'An unnamed account' })),
      uncovered: s.uncovered,
      areas: s.areas.map((a) => ({ area: a.area, uncovered: a.uncovered, items: a.itemIds.map((id) => ({ id, title: titles.get(id) ?? id })) })),
    })),
  };
}
