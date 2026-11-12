// Local stand-in for @forge/bridge. Used only when the page is not running inside Forge.
// Scenario via URL: ?state=sample|live|empty|nothing|partial|error|denied|loading|scanning|applyfail
import type {
  ApplyRequest, ApplyResult, CoverageResponse, PlanRequest, PlanResponse,
  RescanResult, ScanProgress, SetupStatus, UndoResult,
} from '../../../shared/contract';
import { opKeyFor } from './util';
import { ApiError, type PlanEntry, type Successor } from './api';

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
const scenario = params.get('state') ?? 'sample';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mode = scenario === 'live' || scenario === 'applyfail' ? 'live' : 'sample';

const people = [
  { id: 'u-priya', name: 'Priya Nair', team: 'Payments' },
  { id: 'u-dana', name: 'Dana Okafor', team: 'Payments' },
  { id: 'u-ravi', name: 'Ravi Menon', team: 'Payments' },
  { id: 'u-sam', name: 'Sam Whitlock', team: 'Docs' },
  { id: 'u-mei', name: 'Mei Tanaka', team: 'Platform' },
];

function coverage(): CoverageResponse {
  const base = { mode, generatedAt: Date.now() - 12 * 60_000 } as const;
  if (scenario === 'empty') {
    return { ...base, partial: false, notes: [], areas: [], totals: { itemsScanned: 0, singlePointItems: 0, invisibleToAssignee: 0 } };
  }
  if (scenario === 'nothing') {
    return { ...base, partial: false, notes: [], areas: [], totals: { itemsScanned: 412, singlePointItems: 0, invisibleToAssignee: 0 } };
  }
  const areas = [
    { area: 'Payments service', items: 38, truckFactor: 1, topPerson: { id: 'u-priya', name: 'Priya Nair', share: 0.82 }, unassignedToTop: 4, singlePointItems: 6 },
    { area: 'Onboarding docs', items: 14, truckFactor: 1, topPerson: { id: 'u-sam', name: 'Sam Whitlock', share: 0.91 }, unassignedToTop: 0, singlePointItems: 3 },
    { area: 'Q1 Reliability', items: 22, truckFactor: 2, topPerson: { id: 'u-mei', name: 'Mei Tanaka', share: 0.55 }, unassignedToTop: 1, singlePointItems: 1 },
    { area: 'Mobile checkout', items: 29, truckFactor: 3, topPerson: { id: 'u-dana', name: 'Dana Okafor', share: 0.4 }, unassignedToTop: 0, singlePointItems: 0 },
  ];
  const partial = scenario === 'partial';
  return {
    ...base, partial,
    notes: partial ? ['Teamwork Graph is not available, so pull request reviews and team data are missing.', 'Confluence space DOCS could not be read.'] : [],
    areas: partial && params.get('empty') ? [] : areas,
    totals: { itemsScanned: 412, singlePointItems: 19, invisibleToAssignee: 5 },
    ...(params.get('twg') ? { teamworkGraph: { itemsOnlyFromGraph: 23, edgesOnlyFromGraph: 61, byKind: { items: { 'pull request': 17, goal: 6 }, edges: { reviewed: 44, owns: 17 } }, withheldRecords: 0, ablation: { restOnly: { itemsScanned: 412, singlePointItems: 24, invisibleToAssignee: 7 }, withGraph: { itemsScanned: 435, singlePointItems: 19, invisibleToAssignee: 5 } } } } : {}),
  };
}

const sc = (id: string, ev: string[], score = 0.5, load = 0.3): Successor => {
  const p = people.find((x) => x.id === id)!;
  return { personId: id, name: p.name, score, ppr: score / 2, load, evidence: ev };
};
const dana = sc('u-dana', ['Reviewed the last 3 pull requests in this service', 'Commented on 4 related issues'], 0.61, 0.35);
const ravi = sc('u-ravi', ['On the same team', 'Light workload this month'], 0.44, 0.1);
const mei = sc('u-mei', ['Wrote the on-call runbook for this service'], 0.38, 0.5);

function entry(i: number, p: Partial<PlanEntry> & Pick<PlanEntry, 'itemId' | 'title' | 'kind'>): PlanEntry {
  const risk = p.risk ?? 0.5;
  return {
    risk, concentration: 0.8, dueDuringAbsence: false, reasons: [], alternates: [], successor: null,
    operationKey: `op_${i}`,
    breakdown: {
      itemId: p.itemId, concentration: p.concentration ?? 0.8,
      exposure: { priority: 0.75, due: 0.6, open: 1, value: 0.69 }, own: risk * 0.9, inherited: risk * 0.1, total: risk,
    },
    ...p,
  };
}

function buildPlan(r: PlanRequest): PlanResponse {
  const leaver = people.find((p) => p.id === r.leaverId) ?? people[0]!;
  const planKey = `plan_${r.leaverId}_${r.from}`;
  const e: PlanEntry[] = [
    entry(1, { itemId: 'PAY-412', title: 'Refund webhook fails for EU cards', kind: 'workItem', risk: 0.86, dueDuringAbsence: true,
      reasons: [`${leaver.name} holds 82% of the knowledge on this item`, 'Priority is highest', 'Due in 4 days'], successor: dana, alternates: [ravi, mei] }),
    entry(2, { itemId: 'PAY-398', title: 'Ledger rounding off by one cent', kind: 'workItem', risk: 0.64,
      reasons: [`${leaver.name} holds 91% of the knowledge on this item`, 'Priority is high'], successor: ravi, alternates: [dana] }),
    entry(3, { itemId: 'PAY-377', title: 'Retry queue stalls after timeout', kind: 'workItem', risk: 0.52, dueDuringAbsence: true,
      reasons: [`${leaver.name} holds 70% of the knowledge on this item`, 'Due in 11 days'], successor: dana, alternates: [ravi] }),
    entry(4, { itemId: 'page:1001', title: 'Runbook: Chargebacks', kind: 'page', risk: 0.47, concentration: 1,
      reasons: [`${leaver.name} holds 100% of the knowledge on this item`], successor: null }),
    entry(5, { itemId: 'ONB-21', title: 'Rewrite first-week checklist', kind: 'workItem', risk: 0.31,
      reasons: [`${leaver.name} holds 64% of the knowledge on this item`], successor: ravi, alternates: [mei] }),
  ];
  if (scenario === 'nothing') e.length = 0;
  lastEntries = e;
  const groups = e.length ? [
    { area: 'Payments service', maxRisk: 0.86, entries: e.slice(0, 3) },
    { area: 'Onboarding docs', maxRisk: 0.47, entries: [e[3]!, e[4]!] },
  ] : [];
  return {
    mode, partial: scenario === 'partial',
    notes: scenario === 'partial' ? ['Pull request reviews were not available, so some suggestions may rely on Jira comments only.'] : [],
    plan: { planKey, leaverId: leaver.id, leaverName: leaver.name, from: r.from, to: r.to, groups,
      totals: { items: e.length, withoutSuccessor: e.filter((x) => !x.successor).length } },
  };
}

let scanTicks = 0;
let scanStarted = false;
let applied = 0;
let lastEntries: PlanEntry[] = [];
let lastDone = 0;

export async function mockInvoke(name: string, payload?: unknown): Promise<unknown> {
  await delay(scenario === 'loading' ? 60_000 : 250);
  if (scenario === 'error' && name !== 'getSetupStatus') throw new ApiError('Request failed with status 500 (mock)');
  if (scenario === 'denied' && name !== 'getSetupStatus') throw new ApiError('You do not have permission to view this data.', true);
  switch (name) {
    case 'getSetupStatus': {
      const s: SetupStatus = {
        mode,
        checks: [
          { id: 'jira-scopes', ok: true, detail: 'Jira read access is working.' },
          { id: 'teamwork-graph', ok: scenario !== 'partial', detail: scenario !== 'partial' ? 'Teamwork Graph responded.' : 'Teamwork Graph is not available on this site. Ask an admin to turn on the Teamwork Graph preview, then check again.' },
          { id: 'rovo', ok: true, detail: 'Rovo agent is available.' },
          { id: 'mcp', ok: false, detail: 'Connecting other tools (MCP) is off. An admin can turn it on in Atlassian administration.' },
          { id: 'index', ok: scenario !== 'empty', detail: scenario !== 'empty' ? 'Last scan finished 12 minutes ago.' : 'No scan has run yet. Go to Coverage and choose Scan.' },
        ],
      };
      return s;
    }
    case 'getCoverage': return coverage();
    case 'startScan': scanTicks = 0; scanStarted = true; return { state: 'running', done: 0, total: 1200, message: 'Scanning PAY' } satisfies ScanProgress;
    case 'getScanProgress': {
      if (scenario === 'scanning') return { state: 'running', done: 240, total: 1200, message: 'Scanning PAY' } satisfies ScanProgress;
      if (!scanStarted) return { state: 'idle', done: 0, total: 0 } satisfies ScanProgress;
      scanTicks += 1;
      return scanTicks >= 4
        ? ({ state: 'done', done: 1200, total: 1200 } satisfies ScanProgress)
        : ({ state: 'running', done: scanTicks * 300, total: 1200, message: 'Scanning PAY' } satisfies ScanProgress);
    }
    case 'getTimeline': {
      const abs = ((payload as { absences?: Array<{ personId: string; from: number; to: number }> })?.absences ?? []);
      const start = Math.floor(Date.now() / 86_400_000) * 86_400_000;
      return {
        mode, partial: false, notes: [],
        steps: Array.from({ length: 8 }, (_, i) => {
          const a = start + i * 7 * 86_400_000, b = a + 7 * 86_400_000 - 1;
          const away = abs.filter((x) => x.from <= b && x.to + 86_399_999 >= a).map((x) => ({ id: x.personId, name: people.find((p) => p.id === x.personId)?.name ?? x.personId }));
          const priya = away.some((p) => p.id === 'u-priya');
          const areas = priya ? [{ area: 'Payments service', uncovered: 4, items: [{ id: 'PAY-12', title: 'Refund webhook retries' }, { id: 'PAY-31', title: 'Ledger rounding' }, { id: 'PAY-40', title: 'Settlement report' }, { id: 'PAY-44', title: 'Chargeback export' }] }] : [];
          return { start: a, end: b, absent: away, uncovered: areas.reduce((n, x) => n + x.uncovered, 0), areas };
        }),
      };
    }
    case 'listPeople': return people;
    case 'getIssueKnowledge': {
      const key = String((payload as { key?: string } | undefined)?.key ?? 'PAY-1');
      if (key.endsWith('-0')) return { state: 'not-indexed', key };
      return { state: 'ok', key, holder: { name: 'Priya Nair', share: 0.86 }, contributions: 7, assignee: null, singlePoint: true, indexedAt: Date.now() - 36e5,
        evidence: ['Only Priya Nair has answered here (6 of 7 replies)'] };
    }
    case 'buildPlan': applied = 0; lastDone = 0; return buildPlan(payload as PlanRequest);
    case 'applyPlan': {
      const req = payload as ApplyRequest;
      await delay(900);
      const lookup = new Map<string, string>();
      for (const en of lastEntries) {
        lookup.set(en.operationKey, en.itemId);
        for (const pp of people) lookup.set(opKeyFor(req.planKey, en.itemId, pp.id), en.itemId);
      }
      const ids = req.approvedOperationKeys.map((k) => ({ operationKey: k, itemId: lookup.get(k) ?? k }));
      if (mode === 'sample') return { planKey: req.planKey, done: [], failed: [], skippedSample: true } satisfies ApplyResult;
      applied += ids.length;
      const failIdx = scenario === 'applyfail' || scenario === 'live' ? ids.findIndex((x) => x.itemId === 'PAY-398') : -1;
      lastDone += ids.length - (failIdx >= 0 ? 1 : 0);
      return {
        planKey: req.planKey, skippedSample: false,
        done: ids.filter((_, i) => i !== failIdx),
        failed: failIdx >= 0 ? [{ ...ids[failIdx]!, reason: "You don't have edit access to PAY-398. Ask a project admin or choose someone else." }] : [],
      } satisfies ApplyResult;
    }
    case 'rescan': return { planKey: (payload as { planKey: string }).planKey, before: 5, remainingAtRisk: Math.max(0, 5 - lastDone) } satisfies RescanResult;
    case 'undoPlan': return { planKey: (payload as { planKey: string }).planKey, reverted: Math.max(applied - 1, 0), failed: [] } satisfies UndoResult;
    default: throw new ApiError(`Unknown resolver ${name}`);
  }
}
