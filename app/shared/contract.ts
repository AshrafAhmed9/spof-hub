// Shared contract between the Forge backend (app/src) and the Custom UI (app/static/hub).
// Engine types are imported by path; the UI must only use the JSON-serializable shapes below.
import type { HandoverPlan } from '../../engine/src/plan';

export type Mode = 'live' | 'sample';

export interface SetupCheck {
  id: 'teamwork-graph' | 'rovo' | 'mcp' | 'jira-scopes' | 'index';
  ok: boolean;
  /** 'unknown' = the app cannot probe this from code. It is neither passing nor failing; ok is false. */
  status?: 'unknown';
  detail: string;      // plain language, includes how to fix when !ok
}
export interface SetupStatus { mode: Mode; checks: SetupCheck[] }

export interface AreaCoverage {
  area: string;                 // component / epic / space
  items: number;
  truckFactor: number;          // 1 = a single person holds it
  topPerson: { id: string; name: string; share: number };
  unassignedToTop: number;      // items mostly handled by topPerson but not assigned to them
  singlePointItems: number;     // items here where one person holds >= 80% with enough evidence
}
export interface CoverageResponse {
  mode: Mode;
  generatedAt: number;
  partial: boolean;             // true when some sources failed; UI must show a notice
  notes: string[];
  areas: AreaCoverage[];
  totals: { itemsScanned: number; singlePointItems: number; invisibleToAssignee: number; pagesScanned?: number; singleAuthorPages?: number };
  /**
   * Ablation: what exists in the index only because of Teamwork Graph (not found through Jira or
   * Confluence REST). Absent in sample mode. Zero is a valid, honest answer.
   */
  teamworkGraph?: TeamworkGraphLift;
}
export interface TeamworkGraphLift {
  /** Items (PRs, goals, projects, or work items/pages REST did not index) that only Teamwork Graph supplied. */
  itemsOnlyFromGraph: number;
  /** Person-to-item links that only Teamwork Graph supplied. */
  edgesOnlyFromGraph: number;
  byKind: { items: Record<string, number>; edges: Record<string, number> };
  /** Teamwork Graph records that exist but belong to another viewer and were left out for privacy. */
  withheldRecords: number;
  /**
   * The same coverage numbers computed twice: from Jira and Confluence data alone, and with Teamwork Graph added.
   * The difference is what Teamwork Graph changes in the answer.
   */
  ablation?: { restOnly: AblationTotals; withGraph: AblationTotals };
}
export interface AblationTotals { itemsScanned: number; singlePointItems: number; invisibleToAssignee: number }

export interface PlanRequest {
  leaverId: string; from: number; to: number;
  /** Most items one person may receive. Omitted: no limit, work is spread by a load penalty. */
  maxPerPerson?: number;
}
export type PlanResponse = { plan: HandoverPlan; mode: Mode; partial: boolean; notes: string[] };

export interface ApplyRequest {
  planKey: string;
  approvedOperationKeys: string[];
  /** Cover person picked per item (itemId to account id). A pick that differs from the suggestion gets its own operation key. */
  choices?: Record<string, string>;
}
export interface ApplyResult {
  planKey: string;
  done: { operationKey: string; itemId: string }[];
  failed: { operationKey: string; itemId: string; reason: string }[];   // never swallowed
  skippedSample: boolean;       // sample mode previews only; no writes
}
export interface RescanResult { planKey: string; remainingAtRisk: number; before: number }
export interface UndoResult { planKey: string; reverted: number; failed: { itemId: string; reason: string }[] }

export interface ScanProgress { state: 'idle' | 'running' | 'done' | 'error'; done: number; total: number; message?: string; /** Teamwork Graph read progress, when that step ran. */ twg?: { done: number; total: number; failed: number }; /** True when the scan only advances while this page is open. */ needsPage?: boolean }

// Resolver names (invoke from UI via @forge/bridge):
/** What the issue panel shows for one issue. Read from that issue's own index record, not the whole index. */
export interface IssueKnowledge {
  state: 'ok' | 'not-indexed' | 'hidden';
  key: string;
  /** Present when state is ok and anybody has contributed. */
  holder?: { name: string; share: number };
  contributions?: number;
  assignee?: string | null;
  /** True when the item meets the same rule as the Coverage headline. */
  singlePoint?: boolean;
  evidence?: string[];
  indexedAt?: number;
}

export const RESOLVERS = {
  getSetupStatus: 'getSetupStatus',     // () => SetupStatus
  getCoverage: 'getCoverage',           // () => CoverageResponse
  startScan: 'startScan',               // ({projectKeys?: string[]}) => ScanProgress
  getScanProgress: 'getScanProgress',   // () => ScanProgress
  buildPlan: 'buildPlan',               // (PlanRequest) => PlanResponse
  applyPlan: 'applyPlan',               // (ApplyRequest) => ApplyResult
  rescan: 'rescan',                     // ({planKey}) => RescanResult
  undoPlan: 'undoPlan',                 // ({planKey}) => UndoResult
  listPeople: 'listPeople',             // () => {id,name,team?}[]
  getIssueKnowledge: 'getIssueKnowledge', // ({key}) => IssueKnowledge
  getTimeline: 'getTimeline',           // (TimelineRequest) => TimelineResponse
} as const;

export interface TimelineRequest {
  /** People who are away. Days are UTC calendar days, `to` inclusive. */
  absences: Array<{ personId: string; from: number; to: number }>;
  /** First day shown (epoch ms). Default: today. */
  start?: number;
  /** Number of weeks shown. Default 8, at most 26. */
  weeks?: number;
}
export interface TimelineResponse {
  mode: Mode;
  partial: boolean;
  notes: string[];
  steps: Array<{
    start: number;
    end: number;
    absent: Array<{ id: string; name: string }>;
    uncovered: number;
    areas: Array<{ area: string; uncovered: number; items: Array<{ id: string; title: string }> }>;
  }>;
}
