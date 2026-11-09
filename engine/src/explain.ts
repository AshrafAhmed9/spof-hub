import {
  DEFAULT_HALF_LIFE_DAYS,
  eligibleEdges,
  decayFactor,
  type DecayOptions,
} from './concentration';
import { DAY_MS, type EdgeKind, type Graph } from './model';
import { KIND_ORDER, PHRASES, pct } from './phrases';
import type { RiskScore } from './propagation';

export interface ContributorBreakdown {
  personId: string;
  name: string;
  weight: number;
  share: number;
  counts: Partial<Record<EdgeKind, number>>;
  lastActivityAt: number;
}

export interface ConcentrationBreakdown {
  itemId: string;
  personId: string;
  cutoff: number;
  halfLifeDays: number;
  totalWeight: number;
  weight: number;
  contributors: ContributorBreakdown[];
}

export interface Explanation<B> {
  score: number;
  reasons: string[];
  /** Raw numbers for a tooltip. */
  breakdown: B;
}

export function explainConcentration(
  graph: Graph,
  itemId: string,
  personId: string,
  cutoff: number,
  opts: DecayOptions = {},
): Explanation<ConcentrationBreakdown> {
  const hl = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const names = new Map(graph.people.map((p) => [p.id, p.name]));
  const nameOf = (id: string) => names.get(id) ?? 'An unnamed account';

  const byPerson = new Map<string, ContributorBreakdown>();
  let total = 0;
  for (const e of eligibleEdges(graph, cutoff)) {
    if (e.item !== itemId) continue;
    const w = e.weight * decayFactor(cutoff - e.at, hl);
    total += w;
    let c = byPerson.get(e.person);
    if (!c) {
      c = { personId: e.person, name: nameOf(e.person), weight: 0, share: 0, counts: {}, lastActivityAt: e.at };
      byPerson.set(e.person, c);
    }
    c.weight += w;
    c.counts[e.kind] = (c.counts[e.kind] ?? 0) + 1;
    c.lastActivityAt = Math.max(c.lastActivityAt, e.at);
  }
  const contributors = [...byPerson.values()];
  for (const c of contributors) c.share = total > 0 ? c.weight / total : 0;
  contributors.sort((a, b) => b.weight - a.weight || (a.personId < b.personId ? -1 : 1));

  const me = byPerson.get(personId);
  const share = me?.share ?? 0;
  const name = nameOf(personId);
  const breakdown: ConcentrationBreakdown = {
    itemId,
    personId,
    cutoff,
    halfLifeDays: hl,
    totalWeight: total,
    weight: me?.weight ?? 0,
    contributors,
  };

  const reasons: string[] = [];
  if (!me) {
    reasons.push(
      contributors.length === 0
        ? 'No recorded human activity here before the cutoff'
        : `${name} has not contributed here`,
    );
    return { score: 0, reasons, breakdown };
  }

  // Dominant kind: the one where this person has the most events.
  let kind: EdgeKind = KIND_ORDER[0]!;
  let best = -1;
  for (const k of KIND_ORDER) {
    const n = me.counts[k] ?? 0;
    if (n > best) {
      best = n;
      kind = k;
    }
  }
  const mineN = me.counts[kind] ?? 0;
  const allN = contributors.reduce((s, c) => s + (c.counts[kind] ?? 0), 0);
  const ph = PHRASES[kind];

  if (contributors.length === 1) {
    reasons.push(`Only ${name} has ${ph.sole} here (${mineN} of ${allN} ${ph.noun})`);
  } else {
    if (share >= 0.5) reasons.push(`${name} holds ${pct(share)} of the activity here`);
    else reasons.push(`${name} is one of ${contributors.length} contributors here (${pct(share)})`);
    reasons.push(`${name} ${ph.did} ${mineN} of ${allN} ${ph.noun}`);
  }
  const idle = Math.round((cutoff - me.lastActivityAt) / DAY_MS);
  if (Number.isFinite(hl) && idle > hl) reasons.push(`Last activity was ${idle} days before the cutoff, so it is discounted`);
  return { score: share, reasons, breakdown };
}

export interface RiskBreakdown {
  itemId: string;
  concentration: number;
  exposure: RiskScore['exposure'];
  own: number;
  inherited: number;
  total: number;
  via?: string;
}

export function explainRisk(
  graph: Graph,
  risk: RiskScore,
  personId: string,
  now: number,
): Explanation<RiskBreakdown> {
  const item = graph.items.find((i) => i.id === risk.itemId);
  const person = graph.people.find((p) => p.id === personId)?.name ?? 'An unnamed account';
  const reasons: string[] = [];

  if (risk.concentration > 0) {
    reasons.push(`${person} holds ${pct(risk.concentration)} of the knowledge on this item`);
  }
  if (item) {
    if (!item.open) {
      reasons.push('Item is closed, so exposure is low');
    } else {
      if (item.priority) reasons.push(`Priority is ${item.priority}`);
      if (item.dueAt !== undefined) {
        const days = Math.round((item.dueAt - now) / DAY_MS);
        reasons.push(days < 0 ? `Overdue by ${-days} days` : days === 0 ? 'Due today' : `Due in ${days} days`);
      }
    }
  }
  if (risk.via && risk.inherited > 0.01) {
    const via = graph.items.find((i) => i.id === risk.via);
    reasons.push(`Picks up risk from "${via?.title ?? risk.via}" (${pct(risk.inherited)} added)`);
  }
  if (reasons.length === 0) reasons.push('No meaningful risk');

  const breakdown: RiskBreakdown = {
    itemId: risk.itemId,
    concentration: risk.concentration,
    exposure: risk.exposure,
    own: risk.own,
    inherited: risk.inherited,
    total: risk.total,
  };
  if (risk.via !== undefined) breakdown.via = risk.via;
  return { score: risk.total, reasons, breakdown };
}
