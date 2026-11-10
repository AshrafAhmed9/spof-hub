# Successor backtest: frozen definitions

Frozen before any successor result was computed. It reuses the cached Apache data from the first backtest (DEFINITIONS.md): the same five untouched projects (SPARK, CASSANDRA, HIVE, IGNITE, BEAM), the same bot filter, the same departed-contributor rule, the same departure date T. Any later change is listed as a deviation in RESULTS_SUCCESSOR.md.

## Question
When someone departs, does the app's successor ranking put the person who actually picked the item up near the top, compared with simple rules?

## Unit
A pair (L, I): a departed person L and an item I in the item window, created before T, where L wrote at least one non-bot comment at or before T and L's plain comment share of I at or before T is >= 0.5 (the items a handover plan would list).
Per leaver, at most 8 pairs are kept, drawn at random with seed 20260512 (compute limit; the engine runs a graph walk per pair). Pairs are drawn before any result exists.

## Who actually picked it up (the target)
P = author of the first non-bot comment on I after T, within 365 days. Pairs with no such comment are dropped and counted. P must differ from L (always true, since T is L's last comment).

## Candidate pool
People, other than L, with at least one non-bot comment in the same project's item window in (T - 180 days, T]. A pair is dropped and counted when P is not in the pool, since no method could have named P. All methods rank the same pool.

## Information
Every method sees only comments at or before T. Current assignee, resolution date and later comments are never used.

## Methods
1. Engine: `suggestSuccessors` from engine/src, shipped defaults (no time decay, 0.15 restart), graph of all window items created at or before T with comment edges at or before T, edge weight 0.5 (the app's comment weight), pool via `exclude`. Load and team terms are not exercised: no workload or team data exists at T (current assignee only). Candidates the engine does not score are ranked after scored ones, in id order.
2. Most active: pool ordered by number of non-bot comments in the project in (T - 180 days, T], ties by id.
3. Last on item: pool ordered by time of most recent comment on I at or before T (people who never commented on I come after, ordered as method 2).
4. Top on item: pool ordered by number of comments on I at or before T (people with none come after, ordered as method 2).
5. Random: expected value over uniformly random orderings (hit@k = min(k, n) / n, reciprocal rank by the exact expectation).

## Metrics
hit@1, hit@3, mean reciprocal rank (MRR), per method. Reported with n pairs and n leavers.
Paired differences: Engine minus Most active, Engine minus Top on item, and Engine minus Last on item, on hit@3.
95% CI: percentile bootstrap over leavers (2000 resamples, seed 20260512), pooled across the five projects and per project.

## Verdict rule (fixed in advance)
The app's successor ranking is reported as "supported" only if, pooled over the five projects, its hit@3 beats Most active with a CI that excludes 0. It is reported as "not better than a simple rule" if the CI for Engine minus Top on item includes 0 or is negative. Both results are published whichever way they fall.

## Known limits (stated up front)
- "First to comment after T" is a proxy for who took the work over, not a recorded handover.
- Open-source volunteers are not a company's assigned teammates.
- Assignment, workload and team signals are not tested here.
- The 8-pair cap means the per-project numbers are samples.
