import { computeCoverage, findSinglePoints, MIN_EVIDENCE, round, SINGLE_POINT } from '../analysis';
import type { Deps } from '../service';
import { MAX_ROWS, graphOrError, str, type RovoPayload } from './common';

/** Rovo action find_single_points: items where one person holds most of the knowledge. */
export async function run(deps: Deps, p: RovoPayload) {
  const g = await graphOrError(deps);
  const limit = Math.min(MAX_ROWS, Math.max(1, Number(p.limit) || 12));
  const area = str(p.area) || undefined;
  const rows = findSinglePoints(g.graph, g.now, { area, limit });
  // The hub's Coverage page also lists areas where one person holds nearly everything but no item has
  // MIN_EVIDENCE contributions yet. Say so here, or an agent reads an empty list as "nothing concentrated".
  const cov = computeCoverage(g.graph, g.now).areas;
  const matches = cov.filter((a) => !area || a.area.toLowerCase().includes(area.toLowerCase()));
  const areas = matches
    .filter((a) => a.singlePointItems > 0 || a.truckFactor <= 1)
    .slice(0, 10)
    .map((a) => ({
      area: a.area,
      items: a.items,
      singlePointItems: a.singlePointItems,
      topHolder: a.topPerson.name,
      topHolderShare: round(a.topPerson.share),
      ...(a.singlePointItems === 0
        ? { note: `${a.topPerson.name} holds ${Math.round(a.topPerson.share * 100)}% of this area's recorded work. No single item meets the single-point rule (${MIN_EVIDENCE}+ recorded contributions with one person holding at least ${Math.round(SINGLE_POINT * 100)}% of them).` }
        : {}),
    }));
  const notes = [...g.notes];
  if (area && matches.length === 0) notes.push(`No area matches "${area}". Areas are Jira project keys or component names, for example: ${cov.slice(0, 8).map((a) => a.area).join(', ') || 'none indexed'}.`);
  return {
    notes,
    complete: !g.partial,
    basis: 'Share of recent, time-decayed activity (assigning, commenting, authoring, owning). Bots excluded. Only items you can see.',
    count: rows.length,
    areas,
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
