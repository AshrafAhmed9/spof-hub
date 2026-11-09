import { describe, expect, it, vi } from 'vitest';
import type { ApiLike } from './api';
import { PAGE_SIZE, TwgClient, assertOperationName } from './twgClient';

type Reply = { status?: number; body: unknown } | Error;

function apiWith(replies: Reply[]) {
  const calls: Array<{ query: string; variables: any; op?: string }> = [];
  let i = 0;
  const api: ApiLike = {
    asApp: () => {
      throw new Error('TWG must run as the user');
    },
    asUser: () =>
      ({
        requestJira: vi.fn(),
        requestConfluence: vi.fn(),
        requestTeamworkGraph: async (query: string, variables: any, op?: string) => {
          calls.push({ query, variables, op });
          const r = replies[Math.min(i++, replies.length - 1)]!;
          if (r instanceof Error) throw r;
          const status = r.status ?? 200;
          return { status, ok: status < 400, json: async () => r.body, text: async () => JSON.stringify(r.body) };
        },
      }) as any,
  };
  return { api, calls };
}

const conn = (nodes: any[], hasNextPage = false, endCursor = 'c') => ({
  data: { atlassianUserInTeams: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor } } },
});
const team = (n: number) => ({ id: `t${n}`, displayName: `Team ${n}` });
const fast = { sleep: async () => {}, maxRetries: 3 };

describe('operation names', () => {
  it('requires <company>_<operation> with >=3 and >=4 chars', () => {
    expect(() => assertOperationName('spofhub_teams')).not.toThrow();
    expect(() => assertOperationName('ab_teams')).toThrow();
    expect(() => assertOperationName('spofhub_get')).toThrow();
    expect(() => assertOperationName('teams')).toThrow();
  });

  it('sends a valid operation name and puts it in the query text', async () => {
    const { api, calls } = apiWith([{ body: conn([team(1)]) }]);
    await new TwgClient(api, fast).atlassianUserInTeams('acc1');
    expect(calls[0]!.op).toMatch(/^spofhub_[A-Za-z0-9]{4,}$/);
    expect(calls[0]!.query).toContain(`query ${calls[0]!.op}(`);
    expect(calls[0]!.variables.first).toBe(PAGE_SIZE);
    expect(calls[0]!.variables.id).toBe('ari:cloud:identity::user/acc1');
  });
});

describe('HTTP 200 with errors', () => {
  it('is a failure, not an empty list', async () => {
    const body = { errors: [{ message: 'You must set an operation name', extensions: { classification: 'DataFetchingException' } }], data: null };
    const { api } = apiWith([{ status: 200, body }]);
    const r = await new TwgClient(api, fast).atlassianUserInTeams('a');
    expect(r.ok).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.rows).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/DataFetchingException/);
    expect(r.notes.join(' ')).toMatch(/incomplete, not empty/);
  });

  it('treats a thrown request and an HTTP 500 as failures too', async () => {
    const t = await new TwgClient(apiWith([new Error('boom')]).api, fast).atlassianUserInTeams('a');
    expect(t.ok).toBe(false);
    const h = await new TwgClient(apiWith([{ status: 500, body: {} }]).api, fast).atlassianUserInTeams('a');
    expect(h.ok).toBe(false);
  });

  it('treats data with errors as failure even when partial data is present', async () => {
    const { api } = apiWith([{ body: { ...conn([team(1)]), errors: [{ message: 'partial' }] } }]);
    const r = await new TwgClient(api, fast).atlassianUserInTeams('a');
    expect(r.ok).toBe(false);
  });
});

describe('paging', () => {
  it('keeps going on a short page while hasNextPage is true', async () => {
    const { api, calls } = apiWith([
      { body: conn([team(1)], true, 'c1') }, // short page, more to come
      { body: conn([team(2), team(3)], true, 'c2') },
      { body: conn([team(4)], false, 'c3') },
    ]);
    const r = await new TwgClient(api, fast).atlassianUserInTeams('a');
    expect(r.rows.map((t) => t.id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(r.complete).toBe(true);
    expect(calls.map((c) => c.variables.after)).toEqual([null, 'c1', 'c2']);
  });

  it('reports incomplete when a later page fails, keeping earlier rows', async () => {
    const { api } = apiWith([{ body: conn([team(1)], true, 'c1') }, { body: { errors: [{ message: 'nope' }], data: null } }]);
    const r = await new TwgClient(api, fast).atlassianUserInTeams('a');
    expect(r.ok).toBe(false);
    expect(r.complete).toBe(false);
    expect(r.rows).toHaveLength(1);
  });

  it('stops at the page cap and says so', async () => {
    const calls: string[] = [];
    // cursor never repeats, so only the page cap can stop it
    let n = 0;
    const api2: ApiLike = {
      asApp: () => {
        throw new Error('user only');
      },
      asUser: () =>
        ({
          requestTeamworkGraph: async () => {
            calls.push('x');
            return { status: 200, ok: true, json: async () => conn([team(n)], true, `c${n++}`) };
          },
        }) as any,
    };
    const r = await new TwgClient(api2, { ...fast, maxPages: 3 }).atlassianUserInTeams('a');
    expect(calls).toHaveLength(3);
    expect(r.complete).toBe(false);
    expect(r.notes.join(' ')).toMatch(/stopped after 3 pages/);
  });
});

describe('rate limits', () => {
  const limited = { body: { errors: [{ message: 'too many', extensions: { classification: 'RATE_LIMIT_EXCEEDED' } }], data: null } };

  it('retries with backoff and then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const { api, calls } = apiWith([limited, limited, { body: conn([team(1)]) }]);
    const r = await new TwgClient(api, { sleep, maxRetries: 3 }).atlassianUserInTeams('a');
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    const [a, b] = sleep.mock.calls.map((c) => (c as unknown as number[])[0]!);
    expect(b).toBeGreaterThan(a!);
  });

  it('gives up after maxRetries and reports failure, never an empty success', async () => {
    const { api, calls } = apiWith([limited]);
    const r = await new TwgClient(api, { sleep: async () => {}, maxRetries: 2 }).atlassianUserInTeams('a');
    expect(calls).toHaveLength(3);
    expect(r.ok).toBe(false);
    expect(r.empty).toBe(false);
    expect(r.notes.join(' ')).toMatch(/RATE_LIMIT/);
  });

  it('does not retry non-transient errors', async () => {
    const { api, calls } = apiWith([{ body: { errors: [{ message: 'bad field' }], data: null } }]);
    await new TwgClient(api, fast).atlassianUserInTeams('a');
    expect(calls).toHaveLength(1);
  });
});

describe('empty versus failed', () => {
  it('flags a successful zero-row result as empty (ambiguous), not as a failure', async () => {
    const { api } = apiWith([{ body: conn([]) }]);
    const r = await new TwgClient(api, fast).atlassianUserInTeams('a');
    expect(r.ok).toBe(true);
    expect(r.empty).toBe(true);
    expect(r.rows).toEqual([]);
  });

  it('skips null owner nodes and notes it', async () => {
    const body = { data: { confluencePageOwners: { edges: [{ node: null }, { node: { accountId: 'u1', name: 'Una' } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    const r = await new TwgClient(apiWith([{ body }]).api, fast).confluencePageOwners('ari:x');
    expect(r.rows).toEqual([{ accountId: 'u1', name: 'Una' }]);
    expect(r.notes.join(' ')).toMatch(/null user nodes/);
  });

  it('owners with only null nodes is not "no owner": rows empty, but a note says why', async () => {
    const body = { data: { confluencePageOwners: { edges: [{ node: null }], pageInfo: { hasNextPage: false, endCursor: null } } } };
    const r = await new TwgClient(apiWith([{ body }]).api, fast).confluencePageOwners('ari:x');
    expect(r.rows).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/REST ownerId/);
  });
});
