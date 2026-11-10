// Implements every resolver named in shared/contract.ts RESOLVERS.
// Every handler takes an optional `mode: 'live' | 'sample'` in its payload (default live).
// Sample mode never writes: no KVS, no Jira, no queue.
import { RESOLVERS } from '../shared/contract';
import type { ApplyRequest, ApplyResult, CoverageResponse, PlanRequest, PlanResponse, RescanResult, ScanProgress, SetupStatus, UndoResult } from '../shared/contract';
import { apply, buildPlanFor, clearCoverageCache, coverage, listPeople, loadGraph, modeOf, rescan, setupStatus, undo, type Deps } from './service';
import { getProgress, hasPending, pumpScan, startScan } from './scan';
import { advanceTwg } from './twgIndex';
import { SampleMissingError } from './sample';

type Payload = Record<string, any> | undefined;

/** Turns thrown setup problems into a message the UI can show. Everything else rethrows. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SampleMissingError) throw new Error(e.message);
    throw e;
  }
}

export function makeHandlers(deps: Deps) {
  return {
    [RESOLVERS.getSetupStatus]: (p?: Payload): Promise<SetupStatus> => guard(() => setupStatus(deps, modeOf(p))),

    [RESOLVERS.getCoverage]: (p?: Payload): Promise<CoverageResponse> => guard(() => coverage(deps, modeOf(p), (p as any)?.fresh === true)),

    [RESOLVERS.startScan]: async (p?: Payload): Promise<ScanProgress> => {
      if (modeOf(p) === 'sample') return { state: 'done', done: 0, total: 0, message: 'Sample mode: nothing to scan.' };
      await clearCoverageCache(deps);
      return startScan(deps, { projectKeys: p?.projectKeys });
    },

    [RESOLVERS.getScanProgress]: async (p?: Payload): Promise<ScanProgress> => {
      if (modeOf(p) === 'sample') return { state: 'done', done: 0, total: 0, message: 'Sample mode: nothing to scan.' };
      // If the platform queue was unavailable, events wait in app storage and are run here while the page polls.
      await pumpScan(deps);
      // Teamwork Graph reads need the signed-in user, so they run here and not in the queue consumer.
      try {
        await advanceTwg(deps);
      } catch (e) {
        console.warn('Teamwork Graph step failed:', String((e as Error).message));
      }
      const prog = await getProgress(deps);
      if (prog.state === 'running') await clearCoverageCache(deps); // numbers are still moving
      if (prog.state === 'done') {
        // Clear once per finished run, not on every poll, or opening the page would always bypass the cache.
        const run = await deps.store.get<{ runId: string }>('scan:run');
        const seen = await deps.store.get<string>('covstamp');
        if (run && seen !== run.runId) {
          await clearCoverageCache(deps);
          await deps.store.set('covstamp', run.runId);
        }
      }
      const twgOpen = !!prog.twg && prog.twg.done < prog.twg.total;
      return prog.state === 'running' && (twgOpen || (await hasPending(deps))) ? { ...prog, needsPage: true } : prog;
    },

    [RESOLVERS.buildPlan]: (p: Payload): Promise<PlanResponse> => {
      const req = p as PlanRequest;
      if (!req?.leaverId || !Number.isFinite(req.from) || !Number.isFinite(req.to) || req.to < req.from) {
        return Promise.reject(new Error('buildPlan needs leaverId and a from/to range (epoch ms, to >= from).'));
      }
      return guard(() => buildPlanFor(deps, modeOf(p), req));
    },

    [RESOLVERS.applyPlan]: async (p: Payload): Promise<ApplyResult> => {
      const req = p as ApplyRequest;
      if (modeOf(p) === 'sample') return { planKey: req?.planKey ?? '', done: [], failed: [], skippedSample: true };
      if (!req?.planKey || !Array.isArray(req.approvedOperationKeys)) throw new Error('applyPlan needs planKey and approvedOperationKeys.');
      await clearCoverageCache(deps);
      return apply(deps, req.planKey, req.approvedOperationKeys);
    },

    [RESOLVERS.rescan]: (p: Payload): Promise<RescanResult> => guard(() => rescan(deps, modeOf(p), p?.planKey)),

    [RESOLVERS.undoPlan]: async (p: Payload): Promise<UndoResult> => {
      if (modeOf(p) === 'sample') return { planKey: p?.planKey ?? '', reverted: 0, failed: [] };
      await clearCoverageCache(deps);
      return undo(deps, p?.planKey);
    },

    [RESOLVERS.listPeople]: async (p?: Payload) => guard(async () => listPeople((await loadGraph(deps, modeOf(p))).graph)),
  };
}
