// A compact copy of the `item:` records, so a read does not page through thousands of keys (100 rows per round trip).
// Layout: `snap:meta` {gen, chunks, count, builtAt}; `snap:chunk:<gen>:<n>` hold the records; `snap:delta:<id>` hold
// writes made since the snapshot was built. Meta is written last, so a half-written snapshot is never read, and the
// generation in the chunk keys stops two builds from mixing.
import type { Store } from './kv';
import type { IndexedItem } from './types';

export const SNAP_VERSION = 1;
/** Forge's value limit is 240 KiB; stay well under it. */
export const CHUNK_BYTES = 200_000;
/** Above this many deltas the next read folds them into a new snapshot. */
export const DELTA_LIMIT = 200;

const META = 'snap:meta';
const chunkKey = (gen: string, n: number) => `snap:chunk:${gen}:${n}`;
const deltaKey = (id: string) => `snap:delta:${id}`;

interface SnapMeta { version: number; gen: string; chunks: number; count: number; builtAt: number }
type Delta = { v: string; at: number; rec: IndexedItem } | { v: string; at: number; del: true };
const nonce = () => Math.random().toString(36).slice(2, 10);

/** Only what loadGraph reads. Links to the Jira site and the assignee copy are dropped. */
export function compact(r: IndexedItem): IndexedItem {
  return { item: r.item, edges: r.edges, meta: { indexedAt: r.meta?.indexedAt ?? 0 } };
}

/** Every write to an `item:` record goes through here, so the delta is never missed. */
export async function putItem(store: Store, id: string, rec: IndexedItem, now: number): Promise<void> {
  await store.set(`item:${id}`, rec);
  await store.set(deltaKey(id), { v: nonce(), at: now, rec: compact(rec) } satisfies Delta);
}

export async function deleteItem(store: Store, id: string, now: number): Promise<void> {
  await store.del(`item:${id}`);
  await store.set(deltaKey(id), { v: nonce(), at: now, del: true } satisfies Delta);
}

/** Drops the snapshot and every delta. The next read rebuilds from the `item:` records. */
export async function clearSnapshot(store: Store): Promise<void> {
  const metaRow = await store.get<SnapMeta>(META);
  const keys = new Set<string>([META]);
  if (metaRow) for (let n = 0; n < metaRow.chunks; n++) keys.add(chunkKey(metaRow.gen, n));
  // Chunk values are large, so only the small keys are listed by prefix: deltas. Orphan chunks from a crashed build are not reachable by any meta.
  for (const d of await store.list<unknown>('snap:delta:')) keys.add(d.key);
  await Promise.all([...keys].map((k) => store.del(k)));
}

export function splitChunks(recs: IndexedItem[], cap = CHUNK_BYTES): IndexedItem[][] {
  const chunks: IndexedItem[][] = [];
  let cur: IndexedItem[] = [];
  let size = 2;
  for (const r of recs) {
    const n = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (cur.length && size + n > cap) { chunks.push(cur); cur = []; size = 2; }
    cur.push(r);
    size += n;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

export interface Loaded { recs: IndexedItem[]; source: 'snapshot' | 'listing'; deltas: number; applied: Array<{ key: string; v: string }> }

function applyDeltas(base: Map<string, IndexedItem>, deltas: Array<{ key: string; value: Delta }>) {
  for (const d of deltas) {
    const id = d.key.slice('snap:delta:'.length);
    if ('del' in d.value) base.delete(id);
    else base.set(id, d.value.rec);
  }
}

async function readSnapshot(store: Store): Promise<Map<string, IndexedItem> | undefined> {
  const meta = await store.get<SnapMeta>(META).catch(() => undefined);
  if (!meta || meta.version !== SNAP_VERSION || !Number.isInteger(meta.chunks)) return undefined;
  const parts = await Promise.all(Array.from({ length: meta.chunks }, (_, n) => store.get<IndexedItem[]>(chunkKey(meta.gen, n)).catch(() => undefined)));
  if (parts.some((p) => !Array.isArray(p))) return undefined;
  const out = new Map<string, IndexedItem>();
  for (const p of parts) for (const r of p!) out.set(r.item.id, r);
  return out.size === meta.count ? out : undefined;
}

/** Item records from the snapshot plus deltas, or from the full listing when there is no usable snapshot. */
export async function loadItems(store: Store, fanOut?: string[]): Promise<Loaded> {
  // Deltas are listed before the full listing, so each one read here is already in what the listing returns.
  const [snap, deltas] = await Promise.all([readSnapshot(store), store.list<Delta>('snap:delta:')]);
  const applied = deltas.map((d) => ({ key: d.key, v: d.value.v }));
  if (snap) {
    applyDeltas(snap, deltas);
    return { recs: [...snap.values()], source: 'snapshot', deltas: deltas.length, applied };
  }
  const rows = await store.list<IndexedItem>('item:', undefined, fanOut);
  return { recs: rows.map((r) => r.value), source: 'listing', deltas: deltas.length, applied };
}

/** Writes chunks, then meta, then removes the deltas that were folded in and the previous generation's chunks. */
export async function writeSnapshot(store: Store, recs: IndexedItem[], applied: Array<{ key: string; v: string }>, now: number): Promise<void> {
  const old = await store.get<SnapMeta>(META).catch(() => undefined);
  const gen = now.toString(36) + Math.random().toString(36).slice(2, 6);
  const chunks = splitChunks(recs.map(compact));
  await Promise.all(chunks.map((c, n) => store.set(chunkKey(gen, n), c)));
  await store.set(META, { version: SNAP_VERSION, gen, chunks: chunks.length, count: recs.length, builtAt: now } satisfies SnapMeta);
  // A delta rewritten after it was read has a new `v` and stays for the next read.
  await Promise.all(applied.map(async (a) => {
    const cur = await store.get<Delta>(a.key);
    if (cur && cur.v === a.v) await store.del(a.key);
  }));
  if (old && old.gen !== gen) await Promise.all(Array.from({ length: old.chunks }, (_, n) => store.del(chunkKey(old.gen, n))));
}

/** Folds deltas into a fresh snapshot, reading the full listing only when there is none. */
export async function refreshSnapshot(store: Store, now: number, fanOut?: string[]): Promise<Loaded> {
  const l = await loadItems(store, fanOut);
  await writeSnapshot(store, l.recs, l.applied, now);
  return l;
}
