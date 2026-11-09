import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS, buildHandoverPlan, contributionTable } from '../../../engine/src/index';
import { loadSample } from './load';

const here = fileURLToPath(new URL('.', import.meta.url));
const NOW = Date.UTC(2026, 10, 9, 12);
const PRIORITIES = new Set(['highest', 'high', 'medium', 'low', 'lowest']);
const KINDS = new Set(['assigned', 'commented', 'answered', 'authored', 'reviewed', 'owns', 'linked']);
const COMMENT_KINDS = new Set(['commented', 'answered', 'reviewed']);

describe('sample org: graph validity', () => {
  const s = loadSample(NOW);
  const { people, items, edges } = s.graph;
  const pid = new Set(people.map((p) => p.id));
  const iid = new Set(items.map((i) => i.id));

  it('has unique ids and sizes in range', () => {
    expect(pid.size).toBe(people.length);
    expect(iid.size).toBe(items.length);
    expect(people.length).toBeGreaterThanOrEqual(25);
    expect(people.length).toBeLessThanOrEqual(40);
    const wi = items.filter((i) => i.kind === 'workItem');
    expect(wi.length).toBeGreaterThanOrEqual(300);
    expect(wi.length).toBeLessThanOrEqual(500);
    expect(items.filter((i) => i.kind === 'goal').length).toBeGreaterThanOrEqual(3);
  });

  it('has only valid references, kinds and finite times', () => {
    for (const e of edges) {
      expect(pid.has(e.person), e.person).toBe(true);
      expect(iid.has(e.item), e.item).toBe(true);
      expect(KINDS.has(e.kind)).toBe(true);
      expect(Number.isFinite(e.at)).toBe(true);
      expect(e.at).toBeLessThanOrEqual(NOW);
      expect(e.weight).toBeGreaterThan(0);
    }
    const goals = new Set(items.filter((i) => i.kind === 'goal').map((i) => i.id));
    for (const it of items) {
      if (it.priority) expect(PRIORITIES.has(it.priority)).toBe(true);
      if (it.dueAt !== undefined) expect(Number.isFinite(it.dueAt)).toBe(true);
      if (it.goal) expect(goals.has(it.goal)).toBe(true);
      for (const x of [...(it.blocks ?? []), ...(it.links ?? [])]) {
        expect(iid.has(x)).toBe(true);
        expect(x).not.toBe(it.id);
      }
    }
  });

  it('rebases to the given now and returns fresh objects', () => {
    const a = loadSample(NOW);
    const b = loadSample(NOW + 10 * DAY_MS);
    expect(b.graph.edges[0]!.at - a.graph.edges[0]!.at).toBe(10 * DAY_MS);
    a.graph.people[0]!.name = 'mutated';
    expect(loadSample(NOW).graph.people[0]!.name).not.toBe('mutated');
    expect(Math.max(...a.graph.edges.map((e) => e.at))).toBeLessThanOrEqual(NOW);
  });

  it('has the disclosure fields', () => {
    expect(s.metadata.license).toMatch(/Apache/);
    expect(s.metadata.syntheticDisclosure).toMatch(/Goals, teams/);
    expect(s.metadata.counts.edges).toBe(edges.length);
    expect(s.metadata.counts.items).toBe(items.length);
  });
});

describe('sample org: handover plans', () => {
  const s = loadSample(NOW);
  for (const l of s.leavers) {
    it(`builds a non-empty plan for the ${l.profile}`, () => {
      const plan = buildHandoverPlan(s.graph, { leaverId: l.personId, from: NOW, to: NOW + 14 * DAY_MS });
      const entries = plan.groups.flatMap((g) => g.entries);
      console.log(l.profile, l.personId, 'plan entries', entries.length, 'areas', plan.groups.length, 'no successor', plan.totals.withoutSuccessor);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((e) => e.successor !== null)).toBe(true);
    });
  }
});

describe('sample org: the not-assigned finding is measured, not stored', () => {
  it('recomputes the share from the edges with the engine', () => {
    const s = loadSample(NOW);
    const openIds = new Set(s.graph.items.filter((i) => i.kind === 'workItem' && i.open).map((i) => i.id));
    // comment-type edges only, undecayed, like the backtest's "main voice"
    const voice = contributionTable({ ...s.graph, edges: s.graph.edges.filter((e) => COMMENT_KINDS.has(e.kind)) }, NOW);
    const assignee = new Map<string, Set<string>>();
    for (const e of s.graph.edges) if (e.kind === 'assigned') (assignee.get(e.item) ?? assignee.set(e.item, new Set()).get(e.item)!).add(e.person);
    let total = 0, notAssigned = 0;
    for (const l of s.leavers) {
      let t = 0, na = 0;
      for (const [item, row] of voice) {
        if (!openIds.has(item)) continue;
        const sum = [...row.values()].reduce((a, b) => a + b, 0);
        if ((row.get(l.personId) ?? 0) / sum < 0.5) continue;
        t++;
        if (!assignee.get(item)?.has(l.personId)) na++;
      }
      console.log(`leaver ${l.profile}: main voice on ${t} open items, ${na} not assigned (${(100 * na / t).toFixed(0)}%)`);
      expect(t).toBeGreaterThan(5);
      expect(na / t).toBeGreaterThan(0.5);
      total += t; notAssigned += na;
    }
    const share = notAssigned / total;
    console.log(`pooled: ${notAssigned}/${total} = ${(100 * share).toFixed(1)}% of leaver main-voice open items not assigned to them`);
    expect(share).toBeGreaterThan(0.5);
    expect(Math.abs(share - s.metadata.measuredNotAssignedShare.share!)).toBeLessThan(0.001);
  });
});

// The cache is gitignored; this block only runs where it exists.
const cacheDir = join(here, '../../../backtest/cache');
describe.skipIf(!existsSync(cacheDir))('sample org: privacy against the source cache', () => {
  const realNames = new Set<string>(); // usernames
  const realDisplay = new Set<string>();
  const comments: string[] = [];
  for (const f of existsSync(cacheDir) ? readdirSync(cacheDir) : []) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(readFileSync(join(cacheDir, f), 'utf8'));
    for (const issue of d.issues ?? []) {
      if (!String(issue.key).startsWith('KAFKA-')) continue;
      const accts = [issue.fields.assignee, ...issue.fields.comment.comments.map((c: any) => c.author)];
      for (const a of accts) {
        if (!a) continue;
        if (a.name) realNames.add(String(a.name).toLowerCase());
        if (a.displayName) realDisplay.add(String(a.displayName).toLowerCase());
      }
      for (const c of issue.fields.comment.comments) {
        const b = String(c.body ?? '').trim();
        if (b.length >= 40) comments.push(b.slice(0, 40));
      }
    }
  }
  const file = readFileSync(join(here, 'sample-org.json'), 'utf8');
  // metadata names the source project on purpose, so scan everything after it
  const lower = file.slice(file.indexOf('"people"')).toLowerCase();
  const s = loadSample(NOW);

  it('read a meaningful number of real accounts', () => {
    expect(realNames.size).toBeGreaterThan(100);
  });
  it('contains no real usernames', () => {
    const hits = [...realNames].filter((n) => n.length >= 4 && new RegExp(`(^|[^a-z0-9])${n.replace(/[^a-z0-9]/g, '\\$&')}($|[^a-z0-9])`).test(lower));
    expect(hits).toEqual([]);
  });
  it('contains no real display names', () => {
    const hits = [...realDisplay].filter((n) => n.length >= 5 && lower.includes(n));
    expect(hits).toEqual([]);
    for (const p of s.graph.people) expect(realDisplay.has(p.name.toLowerCase())).toBe(false);
  });
  it('contains no emails, urls, avatars, source keys or comment text', () => {
    const body = JSON.stringify({ people: s.graph.people, items: s.graph.items, edges: s.graph.edges });
    expect(body).not.toMatch(/@|https?:|avatar|KAFKA|kafka|apache/i);
    for (const c of comments.slice(0, 5000)) expect(file.includes(c)).toBe(false);
    expect(Object.keys(JSON.parse(file))).toEqual(['metadata', 'people', 'leavers', 'items', 'edges']);
  });
});
