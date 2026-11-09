import type { Edge, Item, Person } from './engine';

/** Index record for one work item or page. Stored under `item:<id>`. */
export interface IndexedItem {
  item: Item;
  edges: Edge[];
  meta: { url?: string; assigneeId?: string | null; indexedAt: number };
}

export type OpStatus = 'applying' | 'done' | 'undone' | 'failed';

/** Audit record per approved operation. Stored under `op:<operationKey>`. Doubles as the undo log. */
export interface OpRecord {
  operationKey: string;
  planKey: string;
  itemId: string;
  toAccountId: string;
  toName: string;
  status: OpStatus;
  /** Steps are recorded as they finish, so a retry resumes instead of repeating them. */
  steps: {
    /** `pending` is written before the call, so a crash mid-step can be reconciled on retry. */
    assignee?: { prev: string | null; now: string; pending?: boolean };
    comment?: { id?: string; pending?: boolean };
    watcher?: { added: boolean; pending?: boolean };
  };
  error?: string;
  at: number;
}

export type { Edge, Item, Person };
