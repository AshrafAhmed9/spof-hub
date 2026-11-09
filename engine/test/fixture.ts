import { DAY_MS, type Edge, type EdgeKind, type Graph, type Item, type Person } from '../src/model';

export const NOW = Date.UTC(2026, 10, 9);
const ago = (d: number) => NOW - d * DAY_MS;

export const people: Person[] = [
  { id: 'priya', name: 'Priya Nair', team: 'auth', load: 0.3 },
  { id: 'ana', name: 'Ana Lopez', team: 'auth', load: 0.2 },
  { id: 'omar', name: 'Omar Haddad', team: 'auth', load: 0.8 },
  { id: 'tom', name: 'Tom Becker', team: 'billing', load: 0.6 },
  { id: 'sam', name: 'Sam Okafor', team: 'billing', load: 0.1 },
  { id: 'li', name: 'Li Wei', team: 'platform', load: 0.5 },
  { id: 'maya', name: 'Maya Cohen', team: 'platform', load: 0.4 },
  { id: 'bot', name: 'ASF GitHub Bot' },
];

const wi = (id: string, area: string, extra: Partial<Item> = {}): Item => ({
  id, kind: 'workItem', title: `${id} ${area} task`, area, open: true, ...extra,
});

export const items: Item[] = [
  // auth: 10 work items, goal G1
  wi('A1', 'auth', { priority: 'highest', dueAt: NOW + 5 * DAY_MS, goal: 'G1', blocks: ['A9'] }),
  wi('A2', 'auth', { priority: 'high', dueAt: NOW + 20 * DAY_MS, goal: 'G1' }),
  wi('A3', 'auth', { priority: 'medium', goal: 'G1', links: ['P1'] }),
  wi('A4', 'auth', { priority: 'medium', goal: 'G1' }),
  wi('A5', 'auth', { priority: 'low', goal: 'G1' }),
  wi('A6', 'auth', { priority: 'high', dueAt: NOW - 3 * DAY_MS, goal: 'G1' }),
  wi('A7', 'auth', { priority: 'medium', goal: 'G1' }),
  wi('A8', 'auth', { priority: 'low', goal: 'G1' }),
  wi('A9', 'auth', { priority: 'high', goal: 'G1' }),
  wi('A10', 'auth', { priority: 'lowest', open: false, goal: 'G1' }),
  // billing: 8 work items, goal G2
  wi('B1', 'billing', { priority: 'highest', dueAt: NOW + 10 * DAY_MS, goal: 'G2', blocks: ['B6'] }),
  wi('B2', 'billing', { priority: 'high', goal: 'G2' }),
  wi('B3', 'billing', { priority: 'medium', goal: 'G2' }),
  wi('B4', 'billing', { priority: 'medium', goal: 'G2' }),
  wi('B5', 'billing', { priority: 'low', goal: 'G2' }),
  wi('B6', 'billing', { priority: 'high', goal: 'G2' }),
  wi('B7', 'billing', { priority: 'medium', goal: 'G2' }),
  wi('B8', 'billing', { priority: 'low', goal: 'G2' }),
  // platform: 4 work items, shared knowledge
  wi('L1', 'platform', { priority: 'medium' }),
  wi('L2', 'platform', { priority: 'medium' }),
  wi('L3', 'platform', { priority: 'low' }),
  wi('L4', 'platform', { priority: 'low' }),
  // pages
  { id: 'P1', kind: 'page', title: 'Auth runbook', area: 'auth', open: true },
  { id: 'P2', kind: 'page', title: 'Token rotation design', area: 'auth', open: true },
  { id: 'P3', kind: 'page', title: 'Billing reconciliation guide', area: 'billing', open: true },
  { id: 'P4', kind: 'page', title: 'Platform on-call notes', area: 'platform', open: true },
  // prs
  { id: 'R1', kind: 'pr', title: 'Rotate signing keys', area: 'auth', open: true, priority: 'high' },
  { id: 'R2', kind: 'pr', title: 'Invoice rounding fix', area: 'billing', open: true, priority: 'medium' },
  // goals
  { id: 'G1', kind: 'goal', title: 'Ship SSO v2', open: true },
  { id: 'G2', kind: 'goal', title: 'Cut invoice disputes by half', open: true },
];

// person, item, kind, days ago, weight
type T = [string, string, EdgeKind, number, number?];
const rows: T[] = [
  // auth: Priya is the only human on A1-A6, with a bot all over it
  ['priya', 'A1', 'assigned', 40], ['priya', 'A1', 'answered', 20], ['priya', 'A1', 'answered', 10], ['bot', 'A1', 'commented', 1, 5],
  ['priya', 'A2', 'authored', 60], ['priya', 'A2', 'answered', 15], ['bot', 'A2', 'commented', 2, 5],
  ['priya', 'A3', 'assigned', 90], ['priya', 'A3', 'commented', 30],
  ['priya', 'A4', 'authored', 120], ['priya', 'A4', 'answered', 50],
  ['priya', 'A5', 'assigned', 200], ['priya', 'A5', 'answered', 100], ['bot', 'A5', 'commented', 3, 3],
  ['priya', 'A6', 'answered', 5], ['priya', 'A6', 'answered', 8], ['priya', 'A6', 'answered', 12],
  ['priya', 'A7', 'authored', 70], ['omar', 'A7', 'reviewed', 20], ['omar', 'A7', 'reviewed', 25],
  ['priya', 'A8', 'answered', 30], ['ana', 'A8', 'answered', 30], ['ana', 'A8', 'commented', 10],
  ['priya', 'A9', 'assigned', 14], ['ana', 'A9', 'authored', 35], ['ana', 'A9', 'answered', 9],
  ['priya', 'A10', 'authored', 300], ['ana', 'A10', 'authored', 280], ['omar', 'A10', 'reviewed', 100],
  // billing: Tom alone on B1-B3, Sam alone on B4-B5, overlap on B6-B8
  ['tom', 'B1', 'assigned', 25], ['tom', 'B1', 'answered', 5],
  ['tom', 'B2', 'authored', 45], ['tom', 'B2', 'answered', 20],
  ['tom', 'B3', 'authored', 80],
  ['sam', 'B4', 'authored', 60], ['sam', 'B4', 'answered', 18],
  ['sam', 'B5', 'assigned', 33],
  ['tom', 'B6', 'authored', 40], ['sam', 'B6', 'reviewed', 12], ['sam', 'B6', 'commented', 22],
  ['tom', 'B7', 'answered', 16], ['sam', 'B7', 'answered', 16], ['ana', 'B7', 'commented', 4],
  ['tom', 'B8', 'authored', 150], ['sam', 'B8', 'authored', 150],
  // platform: li and maya share everything
  ['li', 'L1', 'authored', 30], ['maya', 'L1', 'authored', 31],
  ['li', 'L2', 'assigned', 50], ['maya', 'L2', 'answered', 20],
  ['li', 'L3', 'authored', 90], ['maya', 'L3', 'reviewed', 88],
  ['li', 'L4', 'answered', 10], ['maya', 'L4', 'answered', 11],
  // pages and PRs
  ['priya', 'P1', 'authored', 100], ['priya', 'P1', 'authored', 40], ['bot', 'P1', 'commented', 1, 2],
  ['priya', 'P2', 'authored', 20], ['ana', 'P2', 'commented', 15],
  ['tom', 'P3', 'authored', 70], ['sam', 'P3', 'commented', 60],
  ['li', 'P4', 'authored', 20], ['maya', 'P4', 'authored', 22], ['omar', 'P4', 'commented', 5],
  ['priya', 'R1', 'authored', 7], ['omar', 'R1', 'reviewed', 5],
  ['tom', 'R2', 'authored', 9], ['sam', 'R2', 'reviewed', 8],
  // ownership of goals
  ['priya', 'G1', 'owns', 120], ['tom', 'G2', 'owns', 120],
];

export const edges: Edge[] = rows.map(([person, item, kind, d, w]) => ({
  person, item, kind, at: ago(d), weight: w ?? 1,
}));

export const fixtureOrg: Graph = { people, items, edges };
