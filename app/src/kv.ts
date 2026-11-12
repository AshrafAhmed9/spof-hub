import { kvs, WhereConditions } from '@forge/kvs';

/** The few storage calls the app needs. Tests use an in-memory version. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** All entries whose key starts with prefix (pages through the cursor). */
  list<T>(prefix: string, max?: number): Promise<Array<{ key: string; value: T }>>;
}

export const forgeStore: Store = {
  get: <T>(key: string) => kvs.get<T>(key),
  set: (key, value) => kvs.set(key, value),
  del: (key) => kvs.delete(key),
  async list<T>(prefix: string, max?: number) {
    const out: Array<{ key: string; value: T }> = [];
    let cursor: string | undefined;
    do {
      let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(max ? Math.min(max, 100) : 100);
      if (cursor) q = q.cursor(cursor);
      const page = await q.getMany<T>();
      for (const r of page.results) out.push({ key: r.key, value: r.value });
      cursor = page.nextCursor;
    } while (cursor && (!max || out.length < max));
    return max ? out.slice(0, max) : out;
  },
};

export function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      return data.has(key) ? (structuredClone(data.get(key)) as T) : undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async del(key) {
      data.delete(key);
    },
    async list<T>(prefix: string, max?: number) {
      const all = [...data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
      return max ? all.slice(0, max) : all;
    },
  };
}
