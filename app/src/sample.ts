// Bundled sample org (written by the sample-data agent in src/sample/). Static import: the JSON is
// bundled with the function, no filesystem access. If the file is deleted the build fails, which is the
// clear setup signal; SAMPLE_SETUP_MESSAGE is for the case where the data loads but is unusable.
import { loadSample as loadBundled } from './sample/load';
import type { Graph } from './engine';

export interface SampleOrg {
  graph: Graph;
  /** Sample times are offsets from "now"; this is the rebased "now" used for decay. */
  asOf: number;
  meta: Record<string, unknown>;
}

export const SAMPLE_SETUP_MESSAGE =
  'Sample data is unusable. Check app/src/sample/sample-org.json (engine Graph: people, items, edges) and redeploy.';

export class SampleMissingError extends Error {
  constructor(detail?: string) {
    super(detail ? `${SAMPLE_SETUP_MESSAGE} ${detail}` : SAMPLE_SETUP_MESSAGE);
  }
}

export function loadSample(now: number = Date.now()): SampleOrg {
  let s;
  try {
    s = loadBundled(now);
  } catch (e) {
    throw new SampleMissingError((e as Error).message);
  }
  if (!s?.graph?.people?.length || !s.graph.items?.length) throw new SampleMissingError('It has no people or items.');
  return { graph: s.graph, asOf: now, meta: s.metadata as unknown as Record<string, unknown> };
}
