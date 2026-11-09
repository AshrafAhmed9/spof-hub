// Personal data reporting for Forge storage. The index keeps Atlassian account ids (and display names), so the
// app must report them to Atlassian each cycle and erase what comes back `closed`.
// https://developer.atlassian.com/platform/forge/user-privacy-guidelines/
import type { Store } from './kv';
import type { Person } from './engine';

export interface Account { accountId: string; updatedAt: string }
export interface AccountUpdate { accountId: string; status: 'updated' | 'closed' }

export interface PrivacyDeps {
  store: Store;
  /** `privacy.reportPersonalData` from @forge/api. It splits into batches of 90 and throws on a failed call. */
  report: (accounts: Account[]) => Promise<AccountUpdate[]>;
  /** Fetches current profiles for accounts Atlassian said were `updated`. */
  refresh: (ids: string[]) => Promise<Person[]>;
  now: () => number;
}

export interface SweepResult { reported: number; closed: string[]; refreshed: string[]; skipped: string[] }

/** Written in place of a closed account's id and name. Never reported. */
export const TOMBSTONE_ID = 'deleted-account';
export const TOMBSTONE_NAME = 'Deleted user';

const VALID_ID = /^[A-Za-z0-9:-]{1,128}$/;
const EPOCH = new Date(0).toISOString();
// Records that hold account ids besides `person:`. `plan:` also holds names inside free text, so those are dropped, not edited.
const SCRUB = ['item:', 'twg:rec:', 'op:'] as const;

/** Every account id the stored records point at, with the time its personal data was last fetched. */
async function collectAccounts(store: Store): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const add = (id: unknown, fetchedAt?: string) => {
    if (typeof id !== 'string' || !id) return;
    // First sighting wins and `person:` records are read first, so a known fetch time is never overwritten.
    // Unknown age reports as the epoch, so Atlassian answers `updated` for any later change and we refresh.
    if (!found.has(id)) found.set(id, fetchedAt ?? EPOCH);
  };
  for (const r of await store.list<Person & { fetchedAt?: string }>('person:')) add(r.key.slice('person:'.length), r.value.fetchedAt);
  for (const r of await store.list<any>('item:')) {
    for (const e of r.value?.edges ?? []) add(e.person);
    add(r.value?.meta?.assigneeId);
  }
  for (const r of await store.list<any>('twg:rec:')) {
    add(r.value?.readBy);
    for (const e of r.value?.edges ?? []) add(e.person);
    for (const p of r.value?.people ?? []) add(p.id);
  }
  for (const r of await store.list<any>('op:')) {
    add(r.value?.toAccountId);
    add(r.value?.steps?.assignee?.prev);
    add(r.value?.steps?.assignee?.now);
  }
  return found;
}

/** Copy of `v` with closed ids replaced. An object that held a closed id also loses its name. */
function scrub(v: unknown, closed: Set<string>): { value: unknown; changed: boolean } {
  if (typeof v === 'string') return closed.has(v) ? { value: TOMBSTONE_ID, changed: true } : { value: v, changed: false };
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const r = scrub(x, closed); changed ||= r.changed; return r.value; });
    return { value: out, changed };
  }
  if (v && typeof v === 'object') {
    let changed = false;
    let holdsId = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const r = scrub(x, closed);
      if (typeof x === 'string' && r.changed) holdsId = true;
      changed ||= r.changed;
      out[k] = r.value;
    }
    if (holdsId) for (const k of ['name', 'toName', 'displayName']) if (k in out) out[k] = TOMBSTONE_NAME;
    return { value: out, changed };
  }
  return { value: v, changed: false };
}

async function erase(store: Store, closed: Set<string>): Promise<void> {
  for (const id of closed) await store.del(`person:${id}`);
  for (const prefix of SCRUB) {
    for (const r of await store.list<unknown>(prefix)) {
      const s = scrub(r.value, closed);
      if (s.changed) await store.set(r.key, s.value);
    }
  }
  for (const r of await store.list<unknown>('plan:')) {
    const text = JSON.stringify(r.value);
    if ([...closed].some((id) => text.includes(id))) await store.del(r.key);
  }
}

/**
 * One reporting cycle. Reports every stored account id, erases the closed ones, and refreshes the updated ones.
 * Per-account failures do not stop the sweep, but they are thrown at the end so Forge logs the run as failed.
 */
export async function runPrivacySweep(deps: PrivacyDeps): Promise<SweepResult> {
  const all = await collectAccounts(deps.store);
  const skipped: string[] = [];
  const accounts: Account[] = [];
  for (const [accountId, updatedAt] of all) {
    if (accountId === TOMBSTONE_ID) continue;
    // `unknown` is a Jira placeholder and must not be reported. Anything else malformed would make the whole call fail.
    if (accountId === 'unknown' || !VALID_ID.test(accountId)) skipped.push(accountId);
    else accounts.push({ accountId, updatedAt });
  }
  const updates = accounts.length ? await deps.report(accounts) : [];
  const closed = updates.filter((u) => u.status === 'closed').map((u) => u.accountId);
  const updated = updates.filter((u) => u.status === 'updated').map((u) => u.accountId);
  const errors: string[] = [];

  if (closed.length) {
    try { await erase(deps.store, new Set(closed)); } catch (e) { errors.push(`erase failed for ${closed.length} closed accounts: ${(e as Error).message}`); }
  }
  const refreshed: string[] = [];
  if (updated.length) {
    try {
      const people = await deps.refresh(updated);
      const stamp = new Date(deps.now()).toISOString();
      for (const p of people) {
        if (!updated.includes(p.id)) continue;
        const prev = await deps.store.get<Person>(`person:${p.id}`);
        await deps.store.set(`person:${p.id}`, { ...prev, ...p, fetchedAt: stamp });
        refreshed.push(p.id);
      }
      const missing = updated.filter((id) => !refreshed.includes(id));
      if (missing.length) errors.push(`${missing.length} updated accounts were not returned by the profile lookup and will be retried next cycle`);
    } catch (e) {
      errors.push(`refresh failed for ${updated.length} updated accounts: ${(e as Error).message}`);
    }
  }
  if (skipped.length) errors.push(`${skipped.length} stored ids could not be reported (malformed or "unknown")`);
  const result = { reported: accounts.length, closed, refreshed, skipped };
  console.log('privacy sweep', JSON.stringify({ ...result, closed: closed.length, refreshed: refreshed.length, skipped: skipped.length }));
  if (errors.length) throw new Error(`Privacy sweep finished with errors: ${errors.join('; ')}`);
  return result;
}
