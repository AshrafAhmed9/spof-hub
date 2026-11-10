// Forge entry points. Every handler named in manifest.yml is exported from here.
import Resolver from '@forge/resolver';
import { Queue } from '@forge/events';
import { privacy } from '@forge/api';
import { realApi } from './api';
import { lookupPeople } from './adapters';
import { runPrivacySweep } from './privacy';
import { forgeStore } from './kv';
import { makeHandlers } from './resolvers';
import { handleProductEvent } from './events';
import { handleScanEvent, withStoreFallback } from './scan';
import { TwgClient } from './twgClient';
import type { Deps } from './service';
import * as findSinglePoints from './rovo/findSinglePoints';
import * as atRiskForPerson from './rovo/atRiskForPerson';
import * as suggestSuccessor from './rovo/suggestSuccessor';
import * as handoverBrief from './rovo/handoverBrief';
import type { RovoPayload } from './rovo/common';

const scanQueue = new Queue({ key: 'scan-jobs' });

function deps(siteUrl?: string, ctx?: { accountId?: string; cloudId?: string }): Deps {
  return {
    api: realApi,
    store: forgeStore,
    queue: withStoreFallback({ push: (events) => scanQueue.push(events as any) }, forgeStore, () => Date.now()),
    now: () => Date.now(),
    ...(siteUrl ? { siteUrl } : {}),
    twg: () => new TwgClient(realApi),
    ...(ctx?.accountId ? { viewerId: ctx.accountId } : {}),
    ...(ctx?.cloudId ? { cloudId: ctx.cloudId } : {}),
  };
}

// UI resolver (Custom UI global pages and the issue panel).
const hub = new Resolver();
const names = Object.keys(makeHandlers(deps()));
for (const name of names) {
  hub.define(name, (req: any) => (makeHandlers(deps(req?.context?.siteUrl, req?.context)) as Record<string, (p: unknown) => unknown>)[name]!(req?.payload));
}
export const hubResolver = hub.getDefinitions();

// Queue consumer for chunked scans.
const scan = new Resolver();
scan.define('scan', async (req: any) => {
  const ev = req?.payload?.runId ? req.payload : req?.payload?.body;
  console.log('scan event', ev?.kind, ev?.runId, 'payload keys:', Object.keys(req?.payload ?? {}).join(','));
  if (!ev) return;
  await handleScanEvent(deps(req?.context?.siteUrl), ev);
});
export const scanConsumer = scan.getDefinitions();

// Product-event trigger.
export const onProductEvent = async (event: unknown) => {
  await handleProductEvent(deps(), event);
};

// Shape of each call, so a call from an outside MCP client can be compared with one from the Rovo agent. No values are logged.
function logCall(name: string, p: RovoPayload, ctx?: any) {
  console.log('action call', name, JSON.stringify({ payload: Object.keys(p ?? {}), payloadCtx: Object.keys(p?.context ?? {}), ctx: Object.keys(ctx ?? {}), installContext: ctx?.installContext, installation: ctx?.installation, principal: ctx?.principal?.type, moduleKey: (p?.context as any)?.moduleKey }));
}

// Rovo actions (shared by rovo:agent and rovo:mcp).
export const findSinglePointsAction = (p: RovoPayload, ctx?: any) => { logCall('findSinglePoints', p, ctx); return findSinglePoints.run(deps(undefined, p?.context), p); };
export const atRiskForPersonAction = (p: RovoPayload, ctx?: any) => { logCall('atRiskForPerson', p, ctx); return atRiskForPerson.run(deps(undefined, p?.context), p); };
export const suggestSuccessorAction = (p: RovoPayload, ctx?: any) => { logCall('suggestSuccessor', p, ctx); return suggestSuccessor.run(deps(undefined, p?.context), p); };
export const handoverBriefAction = (p: RovoPayload, ctx?: any) => { logCall('handoverBrief', p, ctx); return handoverBrief.run(deps(undefined, p?.context), p); };

// Weekly personal data report (scheduledTrigger). Throws when anything could not be handled, so Forge logs a failure.
export const privacySweep = async () => {
  await runPrivacySweep({
    store: forgeStore,
    report: (accounts) => privacy.reportPersonalData(accounts),
    refresh: (ids) => lookupPeople(realApi.asApp(), ids),
    now: () => Date.now(),
  });
};
