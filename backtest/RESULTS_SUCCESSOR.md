# Successor backtest results

Protocol: DEFINITIONS_SUCCESSOR.md, committed before any ranking was computed. Same cached Apache data and untouched projects as the first backtest. Raw output: `results_successor.json`; pair-level ranks in `ranks_<PROJECT>.json`. Reproduce: `export_successor.py`, `rank_successor.ts` (vite-node from `engine/`), `summarize_successor.py`.

## Verdict

**By the rule fixed in advance, the successor ranking is not shown to be better than a simple rule.** Pooled over the five projects its hit@3 is 0.42 against 0.41 for "the person who commented most on this item" (difference +0.008, 95% CI -0.049 to +0.071). It is ahead of "most active in the project" by 0.046, but that interval also includes zero (-0.022 to +0.117). Against picking at random (hit@3 0.02) all methods are far ahead.

## Pooled, five untouched projects (518 pairs, 190 leavers, pool about 212 people)

| Method | hit@1 | hit@3 (95% CI) | MRR |
|---|---|---|---|
| Engine (graph walk) | 0.26 | 0.42 (0.36, 0.49) | 0.37 |
| Most active in project, last 180 days | 0.23 | 0.38 (0.31, 0.45) | 0.34 |
| Top commenter on the item | 0.25 | 0.41 (0.35, 0.48) | 0.36 |
| Latest commenter on the item | 0.26 | 0.41 (0.35, 0.48) | 0.37 |
| Random person from the pool | 0.01 | 0.02 | 0.03 |

## Per project (hit@3: engine / most active / top on item)

| Project | pairs | leavers | Engine | Most active | Top on item |
|---|---|---|---|---|---|
| SPARK | 46 | 26 | 0.30 | 0.24 | 0.35 |
| CASSANDRA | 25 | 18 | 0.24 | 0.24 | 0.28 |
| HIVE | 73 | 45 | 0.41 | 0.48 | 0.53 |
| IGNITE | 89 | 39 | 0.48 | 0.09 | 0.20 |
| BEAM | 285 | 62 | 0.44 | 0.47 | 0.47 |

The engine is best in one project (IGNITE), worse than the item-level rules in three (SPARK, CASSANDRA, HIVE) and level in BEAM.

## What the splits say (not part of the verdict)

- **Without BEAM** (post hoc; BEAM is 55% of the pairs): engine 0.40, most active 0.26 (difference +0.142, CI +0.020 to +0.258), top on item 0.34 (+0.056, CI -0.054 to +0.161). The engine clearly beats the project-wide rule there and is still level with the item-level rule.
- **When the person who picked the item up had already commented on it** (75 of 518 pairs): the engine and the item rules all put them in the top three every time; "most active" does so 55% of the time.
- **When the person was new to the item** (443 pairs, 85% of the cases): everyone is much weaker. The engine hit@3 is 0.32 against 0.35 for most active and 0.31 for top on item.

So the walk over the ownership graph mostly rediscovers "who else has worked on this item", which a plain rule does equally well. Its advantage over a project-wide rule shows where activity is spread unevenly (IGNITE) and disappears where a few people answer everything (BEAM, HIVE).

## What this does and doesn't show

- It supports the claim "the suggested successors come from the item's own history and are far better than chance". It does not support "better than a simple rule".
- In the app, the load, team and Teamwork Graph terms add information that was not available here (no historical workload or team data exists at T). They are untested by this backtest.
- First commenter after T is a proxy for who took the work over, not a recorded handover. Open-source volunteers are not an assigned team. Per-leaver sampling (8 pairs) was a compute limit.
