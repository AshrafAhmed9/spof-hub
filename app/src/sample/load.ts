import type { Edge, EdgeKind, Graph, Item, Person, Priority } from '../../../engine/src/model';
import raw from './sample-org.json';

/**
 * Pseudonymized sample organization (see `metadata` in sample-org.json and backtest/make_sample.py).
 * All times in the JSON are millisecond offsets from a baseline: 0 is "now", negative is the past.
 * Plain JSON import, so Forge's bundler needs no fs access.
 */

export interface SampleLeaver {
  personId: string;
  profile: 'engineer' | 'pm' | 'qa';
}

export interface SampleMetadata {
  sourceProject: string;
  license: string;
  transform: string;
  syntheticDisclosure: string;
  counts: { people: number; items: number; workItems: number; openWorkItems: number; goals: number; teams: number; edges: number };
  leavers: Array<SampleLeaver & { mainVoiceOpenItems: number; notAssigned: number; notAssignedShare: number | null; assignedItems: number; comments: number }>;
  measuredNotAssignedShare: {
    definition: string;
    items: number;
    notAssigned: number;
    share: number | null;
    selectionNote: string;
    allNamedPeople: { items: number; notAssigned: number; share: number | null };
  };
}

export interface Sample {
  graph: Graph;
  leavers: SampleLeaver[];
  metadata: SampleMetadata;
}

interface RawItem extends Omit<Item, 'dueAt'> {
  dueOff?: number;
}
type RawEdge = [person: string, item: string, kind: string, offsetMs: number];

const data = raw as unknown as {
  metadata: SampleMetadata;
  people: Person[];
  leavers: SampleLeaver[];
  items: RawItem[];
  edges: RawEdge[];
};

/** Rebase the sample so that its latest activity is `now`. Returns fresh objects each call. */
export function loadSample(now: number): Sample {
  const people: Person[] = data.people.map((p) => ({ ...p }));
  const items: Item[] = data.items.map(({ dueOff, ...rest }) => {
    const it: Item = { ...rest };
    if (it.blocks) it.blocks = [...it.blocks];
    if (it.links) it.links = [...it.links];
    if (dueOff !== undefined) it.dueAt = now + dueOff;
    return it;
  });
  const edges: Edge[] = data.edges.map(([person, item, kind, off]) => ({
    person,
    item,
    kind: kind as EdgeKind,
    at: now + off,
    weight: 1,
  }));
  return {
    graph: { people, items, edges },
    leavers: data.leavers.map((l) => ({ ...l })),
    metadata: data.metadata,
  };
}

export type { Priority };
