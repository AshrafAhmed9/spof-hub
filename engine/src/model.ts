/** Core data types. Times are epoch milliseconds. */

export const DAY_MS = 86_400_000;

export type ItemKind = 'workItem' | 'page' | 'pr' | 'goal';

export type EdgeKind =
  | 'assigned'
  | 'commented'
  | 'answered'
  | 'authored'
  | 'reviewed'
  | 'owns'
  | 'linked';

export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export interface Person {
  id: string;
  name: string;
  team?: string;
  /** Current load as a fraction of capacity, 0..1. Missing means 0. */
  load?: number;
  /** false = on leave / left; never suggested as a successor. Default true. */
  active?: boolean;
  /** Explicit bot flag; the name filter also applies. */
  isBot?: boolean;
}

export interface Item {
  id: string;
  kind: ItemKind;
  title: string;
  /** Component / space / project the item belongs to. */
  area?: string;
  priority?: Priority;
  dueAt?: number;
  open: boolean;
  /** Parent goal id. Risk rolls up along this. */
  goal?: string;
  /** Ids of items this item blocks. Risk flows blocker -> blocked. */
  blocks?: string[];
  /** Ids of related items. Treated as symmetric. */
  links?: string[];
}

export interface Edge {
  person: string;
  item: string;
  kind: EdgeKind;
  at: number;
  /** Contribution weight, > 0. Non-positive or non-finite weights are ignored. */
  weight: number;
}

export interface Graph {
  people: Person[];
  items: Item[];
  edges: Edge[];
}
