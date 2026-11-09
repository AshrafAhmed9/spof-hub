// Typed Teamwork Graph client. Runs as the calling user (requestTeamworkGraph only exists on asUser()).
//
// Gotchas handled here (from Atlassian docs and a community write-up, not yet run on a live site):
// - Every operation needs a name `<company>_<operation>` (company >= 3, operation >= 4 chars).
//   Without it the API answers HTTP 200 with an error in the body.
// - HTTP 200 with an `errors` array is a failure.
// - Curated connections cap `first` at 25. Page while hasNextPage is true; short pages do not mean "last".
// - A rate-limited call can come back with zero rows. Retry with backoff; never treat "failed" as "empty".
// - A missing scope or permission silently drops rows. An empty result is therefore ambiguous
//   and is reported as `empty: true`, which callers turn into a note.
// - Rows are permission-filtered for the calling user.
import type { ApiLike } from './api';

export const PAGE_SIZE = 25;
const COMPANY = 'spofhub';
const TRANSIENT = /RATE_LIMIT|THROTTL|429|502|503|504/i;
const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const userAri = (accountId: string) => `ari:cloud:identity::user/${accountId}`;
export const accountIdFromAri = (ari: string) => ari.replace(/^ari:cloud:identity::user\//, '');
export const pageAri = (cloudId: string, pageId: string) => `ari:cloud:confluence:${cloudId}:page/${pageId}`;
export const issueAri = (cloudId: string, issueId: string) => `ari:cloud:jira:${cloudId}:issue/${issueId}`;

export function assertOperationName(name: string): void {
  const m = /^([A-Za-z0-9]+)_([A-Za-z0-9]+)$/.exec(name);
  if (!m || m[1]!.length < 3 || m[2]!.length < 4 || name.length > 100) {
    throw new Error(`Bad Teamwork Graph operation name "${name}": need <company>_<operation>, company>=3 and operation>=4 chars`);
  }
}

export interface TwgCall {
  ok: boolean;
  data: any;
  error?: string;
  retries: number;
}

export interface TwgRows<T> {
  /** false when any page failed; rows then hold only what was read before the failure. */
  ok: boolean;
  /** false when paging stopped early (failure or page cap). */
  complete: boolean;
  /** true when the call succeeded and returned zero rows. Ambiguous: no data, no permission, or missing scope. */
  empty: boolean;
  rows: T[];
  notes: string[];
}

export interface TwgOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  maxPages?: number;
  company?: string;
}

export interface TwgUser { accountId: string; name: string }
export interface TwgWorkItem { id?: string; key?: string; summary?: string; webUrl?: string; status?: string }
export interface TwgPerson { accountId: string; name?: string }
/** Row from atlassianUserWorkQuery. `type` is the GraphQL __typename (JiraWorkItem or ConfluencePage). */
export interface TwgWorkNode {
  type: string;
  id?: string;
  key?: string;
  pageId?: string;
  title?: string;
  url?: string;
  /** Jira status category key: new | indeterminate | done. */
  statusCategory?: string;
}
export interface TwgPullRequest {
  id: string;
  title?: string;
  url?: string;
  status?: string;
  createdAt?: string;
  author?: TwgPerson;
  reviewers: Array<{ user: TwgPerson; approvalStatus?: string }>;
}
/** Goal or project row from atlassianUserGoalsAndProjects. */
export interface TwgGoalNode { type: string; id: string; name?: string; url?: string; archived?: boolean; owner?: TwgPerson }
export type TwgNode = TwgWorkNode | TwgGoalNode;

const EDGE_PAGE = (field: string, args: string, body: string) => `query OP($id: ID!, $first: Int, $after: String) {
  ${field}(${args}, first: $first, after: $after) {
    edges { node { __typename ${body} } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Field names below come from the Teamwork Graph object-type reference (JiraWorkItem, ConfluencePage,
// ExternalPullRequest, AtlassianGoal, AtlassianProject, AtlassianUser; read 2026-11-09). What the docs do not
// show is the GraphQL type behind `User`-typed fields (owner, author, reviewers[].user); we select
// `... on AtlassianUser { accountId name }` on them, which a live schema may reject. A rejected selection fails
// loudly (errors[]) and surfaces as a note; it never reads as "no rows".
// Fetch <site>/gateway/api/graphql/twg/schema to confirm.
const USER = '... on AtlassianUser { accountId name }';
const Q = {
  inTeams: EDGE_PAGE('atlassianUserInTeams', 'userId: $id', '... on AtlassianTeam { id displayName }'),
  teamMembers: EDGE_PAGE('atlassianTeamMembers', 'teamAri: $id', USER),
  assigned: EDGE_PAGE('atlassianUserAssignedJiraWorkItems', 'userId: $id', '... on JiraWorkItem { id key summary webUrl status { name } }'),
  workQuery: EDGE_PAGE(
    'atlassianUserWorkQuery',
    'userId: $id',
    '... on JiraWorkItem { id key summary webUrl status { name statusCategory { key } } } ... on ConfluencePage { id pageId title webUrl }',
  ),
  pullRequests: EDGE_PAGE(
    'atlassianUserPullRequests',
    'userId: $id',
    `... on ExternalPullRequest { id title url status createdAt author { ${USER} } reviewers { approvalStatus user { ${USER} } } }`,
  ),
  goalsAndProjects: EDGE_PAGE(
    'atlassianUserGoalsAndProjects',
    'userId: $id',
    `... on AtlassianGoal { id name url archived owner { ${USER} } } ... on AtlassianProject { id name url archived owner { ${USER} } }`,
  ),
  pageContributors: EDGE_PAGE('confluencePageContributors', 'id: $id', USER),
  pageOwners: EDGE_PAGE('confluencePageOwners', 'id: $id', USER),
};

export class TwgClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly maxPages: number;
  private readonly company: string;

  constructor(private readonly api: ApiLike, opts: TwgOptions = {}) {
    this.sleep = opts.sleep ?? sleepReal;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxPages = opts.maxPages ?? 40;
    this.company = opts.company ?? COMPANY;
  }

  /** One GraphQL call. Never throws on API trouble; check `ok`. */
  async call(op: string, query: string, variables: Record<string, unknown> = {}): Promise<TwgCall> {
    const operationName = `${this.company}_${op}`;
    assertOperationName(operationName);
    const text = query.replace(/query OP\b/, `query ${operationName}`);
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      let status = 0;
      let json: any = null;
      let thrown: string | undefined;
      try {
        const client = this.api.asUser();
        if (!client.requestTeamworkGraph) throw new Error('requestTeamworkGraph is not available on this runtime');
        const res = await client.requestTeamworkGraph(text, variables, operationName);
        status = res.status;
        json = await res.json().catch(() => null);
      } catch (e) {
        thrown = String((e as Error)?.message ?? e);
      }
      const errors: any[] = Array.isArray(json?.errors) ? json.errors : [];
      let error: string | undefined;
      if (thrown) error = `request failed: ${thrown}`;
      else if (errors.length) {
        const e0 = errors[0];
        error = `${e0?.extensions?.classification ?? e0?.extensions?.errorType ?? 'error'}: ${String(e0?.message ?? '').slice(0, 200)}`;
      } else if (status >= 400) error = `http-${status}`;
      else if (!json || json.data == null) error = 'no-data';
      if (!error) return { ok: true, data: json.data, retries };
      if (attempt < this.maxRetries && TRANSIENT.test(`${error} ${status}`)) {
        retries++;
        await this.sleep(Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100));
        continue;
      }
      return { ok: false, data: json?.data ?? null, error, retries };
    }
  }

  /** Pages one curated connection until hasNextPage is false. */
  async pages<T>(
    op: string,
    query: string,
    variables: Record<string, unknown>,
    field: string,
    mapNode: (node: any) => T | null,
    nullNodeNote?: string,
  ): Promise<TwgRows<T>> {
    const rows: T[] = [];
    const notes: string[] = [];
    let after: string | null = null;
    let nullNodes = 0;
    for (let page = 0; page < this.maxPages; page++) {
      const r = await this.call(op, query, { ...variables, first: PAGE_SIZE, after });
      if (!r.ok) {
        notes.push(`${op}: could not read (${r.error}); result is incomplete, not empty`);
        return { ok: false, complete: false, empty: false, rows, notes };
      }
      const conn = r.data?.[field];
      if (!conn || !Array.isArray(conn.edges)) {
        notes.push(`${op}: response had no "${field}" connection`);
        return { ok: false, complete: false, empty: false, rows, notes };
      }
      for (const e of conn.edges) {
        if (!e || e.node == null) {
          nullNodes++;
          continue;
        }
        const v = mapNode(e.node);
        if (v) rows.push(v);
        else nullNodes++;
      }
      const next = conn.pageInfo?.endCursor;
      // Keep paging on a short page; only hasNextPage=false ends the list.
      if (!conn.pageInfo?.hasNextPage || !next) {
        if (nullNodes && nullNodeNote) notes.push(nullNodeNote);
        return { ok: true, complete: true, empty: rows.length === 0, rows, notes };
      }
      if (next === after) {
        notes.push(`${op}: cursor did not advance; stopped`);
        return { ok: true, complete: false, empty: false, rows, notes };
      }
      after = next;
    }
    notes.push(`${op}: stopped after ${this.maxPages} pages; there is more`);
    return { ok: true, complete: false, empty: false, rows, notes };
  }

  // ---- Curated queries ----
  private user = (n: any): TwgUser | null => (n?.accountId ? { accountId: n.accountId, name: n.name ?? n.accountId } : null);
  private workItem = (n: any): TwgWorkItem | null =>
    n?.__typename === 'JiraWorkItem' || n?.key
      ? { id: n.id, key: n.key, summary: n.summary, webUrl: n.webUrl, status: n.status?.name }
      : null;

  private person = (n: any): TwgPerson | undefined => (n?.accountId ? { accountId: n.accountId, ...(n.name ? { name: n.name } : {}) } : undefined);

  atlassianUserWorkQuery(accountId: string) {
    return this.pages<TwgWorkNode>('userWork', Q.workQuery, { id: userAri(accountId) }, 'atlassianUserWorkQuery', (n) =>
      n?.__typename === 'JiraWorkItem' || n?.__typename === 'ConfluencePage'
        ? {
            type: n.__typename,
            id: n.id,
            key: n.key,
            pageId: n.pageId,
            title: n.summary ?? n.title,
            url: n.webUrl,
            statusCategory: n.status?.statusCategory?.key,
          }
        : null,
    );
  }
  atlassianUserAssignedJiraWorkItems(accountId: string) {
    return this.pages<TwgWorkItem>('assignedWork', Q.assigned, { id: userAri(accountId) }, 'atlassianUserAssignedJiraWorkItems', this.workItem);
  }
  atlassianUserPullRequests(accountId: string) {
    return this.pages<TwgPullRequest>('userPulls', Q.pullRequests, { id: userAri(accountId) }, 'atlassianUserPullRequests', (n) =>
      n?.id
        ? {
            id: n.id,
            title: n.title,
            url: n.url,
            status: n.status,
            createdAt: n.createdAt,
            author: this.person(n.author),
            reviewers: (Array.isArray(n.reviewers) ? n.reviewers : [])
              .map((r: any) => ({ user: this.person(r?.user), approvalStatus: r?.approvalStatus }))
              .filter((r: any) => r.user),
          }
        : null,
    );
  }
  atlassianUserGoalsAndProjects(accountId: string) {
    return this.pages<TwgGoalNode>('userGoals', Q.goalsAndProjects, { id: userAri(accountId) }, 'atlassianUserGoalsAndProjects', (n) =>
      n?.id && (n.__typename === 'AtlassianGoal' || n.__typename === 'AtlassianProject')
        ? { type: n.__typename, id: n.id, name: n.name, url: n.url, archived: n.archived, owner: this.person(n.owner) }
        : null,
    );
  }
  atlassianUserInTeams(accountId: string) {
    return this.pages<{ id: string; name: string }>('userTeams', Q.inTeams, { id: userAri(accountId) }, 'atlassianUserInTeams', (n) =>
      n?.id ? { id: n.id, name: n.displayName ?? n.id } : null,
    );
  }
  atlassianTeamMembers(teamAri: string) {
    return this.pages<TwgUser>('teamMembers', Q.teamMembers, { id: teamAri }, 'atlassianTeamMembers', this.user);
  }
  confluencePageContributors(pageAriValue: string) {
    return this.pages<TwgUser>('pageContribs', Q.pageContributors, { id: pageAriValue }, 'confluencePageContributors', this.user);
  }
  /**
   * A community report says confluencePageOwners can return a null user node. Null nodes are skipped
   * and noted; an empty result here must not be read as "page has no owner". Use the REST ownerId instead.
   */
  confluencePageOwners(pageAriValue: string) {
    return this.pages<TwgUser>(
      'pageOwners',
      Q.pageOwners,
      { id: pageAriValue },
      'confluencePageOwners',
      this.user,
      'confluencePageOwners returned null user nodes; owner unknown from the graph, fall back to the Confluence REST ownerId',
    );
  }
  async echo(): Promise<TwgCall> {
    return this.call('echo', 'query OP { echo(myString: "ping") }');
  }
}
