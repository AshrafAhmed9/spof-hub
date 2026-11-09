import { suggestSuccessors } from '../engine';
import { round } from '../analysis';
import type { Deps } from '../service';
import { graphOrError, pick, str, type RovoPayload } from './common';

/** Rovo action suggest_successor: who should pick up one item, with evidence. */
export async function run(deps: Deps, p: RovoPayload) {
  const key = str(p.itemKey).toUpperCase();
  if (!key) return { error: 'Which item? Give a work item key such as ABC-12.', notes: [] as string[] };
  const g = await graphOrError(deps);
  const id = g.graph.items.some((i) => i.id === key) ? key : g.graph.items.find((i) => i.id === str(p.itemKey))?.id;
  if (!id) return { error: `${key} is not in the scanned data you can see. Run a scan, or check the key.`, notes: g.notes };
  const exclude: string[] = [];
  const notes = [...g.notes];
  if (str(p.excludePerson)) {
    const f = pick(g.graph, str(p.excludePerson));
    if (f.person) exclude.push(f.person.id);
    else notes.push(`Could not exclude "${str(p.excludePerson)}": ${f.error}`);
  }
  const item = g.graph.items.find((i) => i.id === id)!;
  const ranked = suggestSuccessors(g.graph, id, g.now, { k: 3, exclude });
  return {
    notes,
    complete: !g.partial,
    item: { id, title: item.title.slice(0, 120), area: item.area ?? null },
    candidates: ranked.map((s) => ({ id: s.personId, name: s.name, score: round(s.score), load: round(s.load), because: s.evidence.slice(0, 4) })),
    ...(ranked.length === 0 ? { message: 'Nobody in the scanned data is connected to this item closely enough to suggest. Do not guess.' } : {}),
  };
}
