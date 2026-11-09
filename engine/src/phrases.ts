import type { EdgeKind } from './model';

/** Wording shared by explanations and successor evidence. */
export const PHRASES: Record<
  EdgeKind,
  { sole: string; did: string; noun: string; evidenceNoun: string }
> = {
  answered: { sole: 'answered', did: 'answered', noun: 'replies', evidenceNoun: 'questions' },
  commented: { sole: 'commented', did: 'wrote', noun: 'comments', evidenceNoun: 'comments' },
  authored: { sole: 'authored work', did: 'authored', noun: 'contributions', evidenceNoun: 'contributions' },
  reviewed: { sole: 'reviewed', did: 'reviewed', noun: 'reviews', evidenceNoun: 'reviews' },
  assigned: { sole: 'been assigned', did: 'was assigned', noun: 'assignments', evidenceNoun: 'assignments' },
  owns: { sole: 'been listed as owner', did: 'owns', noun: 'ownership entries', evidenceNoun: 'ownership entries' },
  linked: { sole: 'linked related work', did: 'linked', noun: 'links', evidenceNoun: 'links' },
};

export const KIND_ORDER: EdgeKind[] = [
  'owns',
  'authored',
  'answered',
  'reviewed',
  'assigned',
  'commented',
  'linked',
];

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
