import { RESOLVERS } from '../../../shared/contract';
import type {
  ApplyRequest, ApplyResult, CoverageResponse, IssueKnowledge, RunSummary, PlanRequest, PlanResponse,
  RescanResult, ScanProgress, SetupStatus, TimelineRequest, TimelineResponse, UndoResult,
} from '../../../shared/contract';

export type HandoverPlan = PlanResponse['plan'];
export type PlanGroup = HandoverPlan['groups'][number];
export type PlanEntry = PlanGroup['entries'][number];
export type Successor = NonNullable<PlanEntry['successor']>;
export type Person = { id: string; name: string; team?: string };

export class ApiError extends Error {
  denied: boolean;
  constructor(message: string, denied = false) {
    super(message);
    this.denied = denied;
  }
}

type Invoke = (name: string, payload?: unknown) => Promise<unknown>;

declare global {
  interface Window { __FORGE__?: unknown; __bridge?: unknown }
}

// Real bridge by default. The mock is used only on localhost or with `?mock=1` (screenshots, local dev),
// so a missing bridge flag inside Jira can never silently show fake data.
export const isForge =
  typeof window !== 'undefined' &&
  !new URLSearchParams(window.location.search).has('mock') &&
  !['localhost', '127.0.0.1', ''].includes(window.location.hostname);

let invokeImpl: Promise<Invoke> | undefined;
function getInvoke(): Promise<Invoke> {
  invokeImpl ??= isForge
    ? import('@forge/bridge').then((m) => m.invoke as Invoke)
    : import('./mockBridge').then((m) => m.mockInvoke as Invoke);
  return invokeImpl;
}

function looksDenied(e: unknown): boolean {
  const o = e as { code?: unknown; status?: unknown; message?: unknown };
  const msg = String(o?.message ?? e);
  return o?.code === 'PERMISSION_DENIED' || o?.status === 403 || /permission|forbidden|403|not authori[sz]ed/i.test(msg);
}

let currentMode: 'live' | 'sample' = 'live';
export function setApiMode(m: 'live' | 'sample') { currentMode = m; }

async function call<T>(name: string, payload?: unknown): Promise<T> {
  try {
    const invoke = await getInvoke();
    return (await invoke(name, { ...(payload as object | undefined), mode: currentMode })) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const message = e instanceof Error ? e.message : String(e);
    throw new ApiError(message, looksDenied(e));
  }
}

/** Undo runs in slices so each call stays inside the platform time limit. A slice that errors is repeated, which is safe because finished steps are skipped. */
async function undoAll(planKey: string, onProgress?: (p: { at: number; total: number }) => void): Promise<UndoResult> {
  const merged: UndoResult = { planKey, reverted: 0, failed: [] };
  let cursor: number | undefined;
  for (;;) {
    let r: UndoResult | undefined;
    for (let attempt = 0; !r; attempt++) {
      try {
        r = await call<UndoResult>(RESOLVERS.undoPlan, { planKey, cursor });
      } catch (e) {
        if (attempt >= 2) throw e;
      }
    }
    merged.reverted += r.reverted;
    merged.failed.push(...r.failed);
    if (r.next === undefined) return merged;
    cursor = r.next;
    onProgress?.({ at: r.next, total: r.total ?? r.next });
  }
}

export const api = {
  getSetupStatus: () => call<SetupStatus>(RESOLVERS.getSetupStatus),
  getCoverage: () => call<CoverageResponse>(RESOLVERS.getCoverage),
  startScan: (projectKeys?: string[]) => call<ScanProgress>(RESOLVERS.startScan, { projectKeys }),
  getScanProgress: () => call<ScanProgress>(RESOLVERS.getScanProgress),
  buildPlan: (r: PlanRequest) => call<PlanResponse>(RESOLVERS.buildPlan, r),
  applyPlan: (r: ApplyRequest) => call<ApplyResult>(RESOLVERS.applyPlan, r),
  rescan: (planKey: string) => call<RescanResult>(RESOLVERS.rescan, { planKey }),
  undoPlan: (planKey: string, onProgress?: (p: { at: number; total: number }) => void) => undoAll(planKey, onProgress),
  listRuns: () => call<RunSummary[]>(RESOLVERS.listRuns),
  listPeople: () => call<Person[]>(RESOLVERS.listPeople),
  getTimeline: (r: TimelineRequest) => call<TimelineResponse>(RESOLVERS.getTimeline, r),
  getIssueKnowledge: (key: string) => call<IssueKnowledge>(RESOLVERS.getIssueKnowledge, { key }),
};
