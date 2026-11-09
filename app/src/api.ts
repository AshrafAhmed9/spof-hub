import forgeApi, { route } from '@forge/api';

export { route };

/** Minimal response shape; the real Forge APIResponse satisfies it. */
export interface Res {
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
  json(): Promise<any>;
  text(): Promise<string>;
}

export interface Client {
  requestJira(path: any, init?: any): Promise<Res>;
  requestConfluence(path: any, init?: any): Promise<Res>;
  requestTeamworkGraph?(query: string, variables?: any, operationName?: string): Promise<Res>;
}

/** What the app needs from @forge/api, so tests can pass a mock. */
export interface ApiLike {
  asUser(): Client;
  asApp(): Client;
}

export const realApi: ApiLike = {
  asUser: () => forgeApi.asUser() as unknown as Client,
  asApp: () => forgeApi.asApp() as unknown as Client,
};

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Retry {
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
}

/**
 * Runs a REST call and retries on 429 / 503. Honors Retry-After when present.
 * Returns the last response; callers must check `.ok`.
 */
export async function withRetry(fn: () => Promise<Res>, opts: Retry = {}): Promise<Res> {
  const sleep = opts.sleep ?? sleepReal;
  const attempts = opts.attempts ?? 4;
  let res!: Res;
  for (let i = 0; i < attempts; i++) {
    res = await fn();
    if (res.status !== 429 && res.status !== 503) return res;
    const ra = Number(res.headers?.get('retry-after'));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 10) * 1000 : Math.min(4000, 300 * 2 ** i));
  }
  return res;
}
