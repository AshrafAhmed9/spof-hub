import { findSinglePoints } from '../analysis';
import type { Deps } from '../service';
import { MAX_ROWS, graphOrError, str, type RovoPayload } from './common';

/** Rovo action find_single_points: items where one person holds most of the knowledge. */
export async function run(deps: Deps, p: RovoPayload) {
  const g = await graphOrError(deps);
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(p.limit) || 12));
  const rows = findSinglePoints(g.graph, g.now, { area: str(p.area) || undefined, limit });
  return {
    notes: g.notes,
    complete: !g.partial,
    basis: 'Share of recent, time-decayed activity (assigning, commenting, authoring, owning). Bots excluded. Only items you can see.',
    count: rows.length,
    singlePoints: rows.map((r) => ({
      item: r.itemId,
      title: r.title.slice(0, 120),
      area: r.area,
      holder: r.holder,
      assignedTo: r.assignee,
      why: r.evidence.slice(0, 4),
    })),
  };
}
