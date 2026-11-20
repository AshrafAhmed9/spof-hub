import { kvs, WhereConditions } from '@forge/kvs';

/** The few storage calls the app needs. Tests use an in-memory version. */
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** All entries whose key starts with prefix (pages through the cursor). */
  list<T>(prefix: string, max?: number, fanOut?: string[]): Promise<Array<{ key: string; value: T }>>;
}

export const forgeStore: Store = {
  get: <T>(key: string) => kvs.get<T>(key),
  set: (key, value) => kvs.set(key, value),
  del: (key) => kvs.delete(key),
  async list<T>(prefix: string, max?: number, fanOut?: string[]) {
    // A cursor chain is sequential (100 rows per round trip). When the caller knows how keys start,
    // one chain per start runs in parallel. Results are concatenated; key order is not promised.
    const one = async (pre: string, cap?: number) => {
      const out: Array<{ key: string; value: T }> = [];
      let cursor: string | undefined;
      do {
        let q = kvs.query().where('key', WhereConditions.beginsWith(pre)).limit(cap ? Math.min(cap, 100) : 100);
        if (cursor) q = q.cursor(cursor);
        const page = await q.getMany<T>();
        for (const r of page.results) out.push({ key: r.key, value: r.value });
        cursor = page.nextCursor;
      } while (cursor && (!cap || out.length < cap));
      return cap ? out.slice(0, cap) : out;
    };
    if (fanOut?.length && !max) return (await Promise.all(fanOut.map((c) => one(prefix + c)))).flat();
    return one(prefix, max);
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
    async list<T>(prefix: string, max?: number, _fanOut?: string[]) {
      const all = [...data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value: structuredClone(value) as T }));
      return max ? all.slice(0, max) : all;
    },
  };
}
