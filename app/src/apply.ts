// Apply / undo / rescan. Writes go out as the calling user (asUser), so Jira enforces their permissions.
// Every operation has a stored record keyed by operationKey; steps are recorded as they finish so a retry
// resumes where it stopped and never repeats a finished step.
import { route, withRetry, type ApiLike, type Client, type Retry } from './api';
import type { HandoverPlan, PlanEntry } from './engine';
import type { Store } from './kv';
import type { OpRecord } from './types';
import type { ApplyResult, UndoResult } from '../shared/contract';

export interface ApplyDeps { api: ApiLike; store: Store; now: () => number; retry?: Retry }

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

class StepError extends Error {}

async function expectOk(res: { ok: boolean; status: number; text(): Promise<string> }, what: string) {
  if (res.ok) return;
  let body = '';
  try {
    body = (await res.text()).slice(0, 400);
  } catch { /* ignore */ }
  throw new StepError(`${what} failed. ${explain(res.status, body)}`);
}

/** Turns Jira's error body into a sentence a person can act on, keeping the status for support. */
function explain(status: number, body: string): string {
  let msgs: string[] = [];
  try {
    const j = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string> };
    msgs = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].filter(Boolean);
  } catch { /* not JSON */ }
  const text = msgs.join(' ');
  if (/cannot be assigned/i.test(text)) return 'That person is not allowed to take issues in this project. Choose someone else, or ask a Jira admin to give them the Assignable User permission.';
  if (status === 403 || /permission/i.test(text)) return 'You do not have permission to change this issue.';
  if (status === 404) return 'The issue could not be found. It may have been moved or deleted.';
  return `${text || body.slice(0, 120) || 'No details were returned.'} (HTTP ${status})`;
}

async function currentAssignee(c: Client, key: string, retry?: Retry): Promise<string | null> {
  const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${key}?fields=assignee`, { headers: { Accept: 'application/json' } }), retry);
  await expectOk(res, `reading ${key}`);
  return (await res.json()).fields?.assignee?.accountId ?? null;
}

const adf = (text: string) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export function commentText(plan: HandoverPlan, e: PlanEntry): string {
  const why = e.reasons.slice(0, 2).join('. ');
  const from = new Date(plan.from).toISOString().slice(0, 10);
  const to = new Date(plan.to).toISOString().slice(0, 10);
  return `Handover: ${plan.leaverName} is away ${from} to ${to}. ${e.successor!.name} now owns this item. Why: ${why}. [ref ${e.operationKey}]`;
}

const opKeyStore = (k: string) => `op:${k}`;

export async function applyPlan(deps: ApplyDeps, planKey: string, approved: string[]): Promise<ApplyResult> {
  const result: ApplyResult = { planKey, done: [], failed: [], skippedSample: false };
  const plan = await deps.store.get<HandoverPlan>(`plan:${planKey}`);
  if (!plan) {
    for (const k of approved) result.failed.push({ operationKey: k, itemId: '', reason: `Plan ${planKey} was not found. Build the plan again.` });
    return result;
  }
  const entries = new Map(plan.groups.flatMap((g) => g.entries).map((e) => [e.operationKey, e]));
  const listed = (await deps.store.get<string[]>(`planops:${planKey}`)) ?? [];
  const user = deps.api.asUser();

  for (const key of [...new Set(approved)]) {
    const entry = entries.get(key);
    if (!entry) {
      result.failed.push({ operationKey: key, itemId: '', reason: 'Operation key is not part of this plan.' });
      continue;
    }
    try {
      await applyOne(deps, user, plan, entry);
      result.done.push({ operationKey: key, itemId: entry.itemId });
    } catch (e) {
      result.failed.push({ operationKey: key, itemId: entry.itemId, reason: (e as Error).message });
    }
    if (!listed.includes(key)) listed.push(key);
  }
  await deps.store.set(`planops:${planKey}`, listed);
  return result;
}

async function applyOne(deps: ApplyDeps, c: Client, plan: HandoverPlan, e: PlanEntry): Promise<void> {
  if (!e.successor) throw new StepError('No successor was suggested for this item.');
  if (e.kind !== 'workItem') throw new StepError(`Writes are only supported for Jira work items, not ${e.kind}s. Hand this one over by hand.`);
  const to = e.successor.personId;
  let op = await deps.store.get<OpRecord>(opKeyStore(e.operationKey));
  if (op?.status === 'done') return; // already applied: retry is a no-op
  if (!op || op.status === 'undone') {
    op = { operationKey: e.operationKey, planKey: plan.planKey, itemId: e.itemId, toAccountId: to, toName: e.successor.name, status: 'applying', steps: {}, at: deps.now() };
  }
  const save = async () => deps.store.set(opKeyStore(e.operationKey), op);
  op.status = 'applying';
  delete op.error;
  await save();

  try {
    // 1. assignee
    if (!op.steps.assignee || op.steps.assignee.pending) {
      const cur = await currentAssignee(c, e.itemId, deps.retry);
      const prev = op.steps.assignee ? op.steps.assignee.prev : cur;
      if (cur === to) {
        op.steps.assignee = { prev, now: to };
      } else {
        op.steps.assignee = { prev, now: to, pending: true };
        await save();
        const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${e.itemId}/assignee`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ accountId: to }) }), deps.retry);
        await expectOk(res, 'reassigning');
        op.steps.assignee = { prev, now: to };
      }
      await save();
    }
    // 2. comment (the [ref ...] tag lets a retry find a comment that posted but was not recorded)
    if (!op.steps.comment?.id) {
      if (op.steps.comment?.pending) {
        const found = await findComment(c, e.itemId, e.operationKey, deps.retry);
        if (found) op.steps.comment = { id: found };
      }
      if (!op.steps.comment?.id) {
        op.steps.comment = { pending: true };
        await save();
        const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${e.itemId}/comment`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body: adf(commentText(plan, e)) }) }), deps.retry);
        await expectOk(res, 'commenting');
        op.steps.comment = { id: String((await res.json()).id) };
      }
      await save();
    }
    // 3. watcher
    if (!op.steps.watcher || op.steps.watcher.pending) {
      const wres = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${e.itemId}/watchers`, { headers: { Accept: 'application/json' } }), deps.retry);
      await expectOk(wres, 'reading watchers');
      const already = ((await wres.json()).watchers ?? []).some((w: any) => w.accountId === to);
      if (already && !op.steps.watcher?.pending) {
        op.steps.watcher = { added: false };
      } else if (already) {
        op.steps.watcher = { added: true }; // pending add had landed before the crash
      } else {
        op.steps.watcher = { added: true, pending: true };
        await save();
        const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${e.itemId}/watchers`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(to) }), deps.retry);
        await expectOk(res, 'adding watcher');
        op.steps.watcher = { added: true };
      }
      await save();
    }
    op.status = 'done';
    await save();
  } catch (err) {
    op.status = 'failed';
    op.error = (err as Error).message;
    await save();
    throw err;
  }
}

async function findComment(c: Client, key: string, opKey: string, retry?: Retry): Promise<string | null> {
  const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${key}/comment?maxResults=100&orderBy=-created`, { headers: { Accept: 'application/json' } }), retry);
  if (!res.ok) return null;
  for (const cm of (await res.json()).comments ?? []) if (JSON.stringify(cm.body ?? '').includes(`[ref ${opKey}]`)) return String(cm.id);
  return null;
}

export async function undoPlan(deps: ApplyDeps, planKey: string): Promise<UndoResult> {
  const out: UndoResult = { planKey, reverted: 0, failed: [] };
  const keys = (await deps.store.get<string[]>(`planops:${planKey}`)) ?? [];
  const c = deps.api.asUser();
  for (const k of keys) {
    const op = await deps.store.get<OpRecord>(opKeyStore(k));
    if (!op || op.status === 'undone') continue;
    const save = () => deps.store.set(opKeyStore(k), op);
    try {
      // Reverse order: watcher, comment, assignee.
      if (op.steps.watcher?.added) {
        const q = new URLSearchParams({ accountId: op.toAccountId });
        const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${op.itemId}/watchers?${q}`, { method: 'DELETE' }), deps.retry);
        if (!res.ok && res.status !== 404) await expectOk(res, 'removing watcher');
        delete op.steps.watcher;
        await save();
      }
      if (op.steps.comment && !op.steps.comment.id) {
        const found = await findComment(c, op.itemId, op.operationKey, deps.retry);
        if (found) op.steps.comment = { id: found };
        else delete op.steps.comment; // never posted
      }
      if (op.steps.comment?.id) {
        const id = op.steps.comment.id;
        const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${op.itemId}/comment/${id}`, { method: 'DELETE' }), deps.retry);
        if (!res.ok && res.status !== 404) await expectOk(res, 'deleting comment');
        delete op.steps.comment;
        await save();
      }
      if (op.steps.assignee) {
        const a = op.steps.assignee;
        const cur = await currentAssignee(c, op.itemId, deps.retry);
        if (cur !== a.now && cur !== a.prev) throw new StepError(`Assignee changed since the handover (now ${cur ?? 'nobody'}); left as is.`);
        if (cur !== a.prev) {
          const res = await withRetry(() => c.requestJira(route`/rest/api/3/issue/${op.itemId}/assignee`, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ accountId: a.prev }) }), deps.retry);
          await expectOk(res, 'restoring assignee');
        }
        delete op.steps.assignee;
      }
      op.status = 'undone';
      await save();
      out.reverted++;
    } catch (e) {
      op.error = (e as Error).message;
      await save();
      out.failed.push({ itemId: op.itemId, reason: (e as Error).message });
    }
  }
  return out;
}
