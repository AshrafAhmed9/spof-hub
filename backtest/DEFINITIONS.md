# Frozen definitions (written before any confirmation run)

Frozen: 2026-11-09, before running run.py on SPARK, CASSANDRA, HIVE, IGNITE, BEAM.
KAFKA, FLINK, HBASE were used in exploratory probes and are DEVELOPMENT data. They are reported separately and never used for the verdict.
Any change to this file after the confirmation run must be listed in RESULTS.md as a deviation.

## Data
- Source: https://issues.apache.org/jira/rest/api/2/search, anonymous, fields = comment, assignee, created, resolutiondate, status. <=2 req/s, every response cached in backtest/cache.
- Item window: issues created 2018-01-01 .. 2023-06-30 (inclusive) per project.
- Activity tail: issues created 2023-07-01 .. fetch date are fetched only to find a person's last activity (so someone still commenting on new issues is not called departed). Tail issues are never analysed as items.
- Issues created before 2018 are not fetched (caveat: activity on them is invisible).
- Person identity: Jira account `name` (fallback `key`, then `displayName`).

## Bot filter
A comment is a bot comment, and is dropped from every count, if either:
- author name/displayName matches (case-insensitive): `asf github bot`, `asf subversion`, `hudson`, `jenkins`, `jira-bot`, `jira bot`, `hadoop qa`, `hive qa`, `sparkqa`, `amplabjenkins`, `githubbot`, `\bbot\b`, `qa bot`, `build bot`, `ci-bot`, `apachespark`, `snyk`, `dependabot`, `github-actions`, `asfbot`.
- body matches an automated template: starts with or contains `Integrated in .* build`, `Commit [0-9a-f]{7,} in`, `User '.*' has created a pull request`, `GitHub user .* has created a pull request`, `Github user`, `Can one of the admins verify this patch`, `Test build #`, `\| Vote \|`, `-1 overall`, `+1 overall`, `Merged build finished`, `Test PASSed`, `Test FAILed`, `Build succeeded`, `Build failed`, `Closing this PR`/`Issue resolved by pull request`, `This issue has been automatically marked`.
Other accounts are treated as human.

## Departed contributor
A person with all of:
- >=30 non-bot comments in the item window,
- last non-bot comment anywhere (item window or tail) at time T, with T <= fetch date - 365 days (so a full 365-day follow-up exists).
T is the departure date. A person's last comment is at T; "before departure" = comment time <= T, "after" = comment time > T.

## Unit of analysis
Pair (departed person L, item I) where: I is in the item window, I created before T, L wrote >=1 non-bot comment on I at time <= T, (no other filter). The denominator for concentration is all non-bot comments on I at time <= T (including L's).
Inclusion requires an outcome to exist: at least one non-bot comment on I in (T, T+365d]. Pairs without one are dropped and counted.
Clustering unit for CI: the departed person L.

## Concentration (primary)
weight(c) = 0.5 ** ((T - time(c)) / 180 days); concentration = sum weight of L's non-bot comments on I / sum weight of all non-bot comments on I, all with time <= T.
Buckets: high >= 0.5, low < 0.25. 0.25..0.5 is "middle" and excluded from the contrast (reported for information).

## Outcome
Let c1 = first non-bot comment on I after T, by person P, within 365 days of T. "Unanswered" = there is NO non-bot comment on I by a person other than P with time in (time(c1), time(c1)+30d]. Unanswered = 1, answered = 0. (L cannot be P, since T is L's last comment.)

## Metrics
- Unanswered-rate per bucket, n per bucket (pairs and distinct leavers).
- Difference = rate(high) - rate(low).
- 95% CI: percentile bootstrap, 2000 resamples of departed persons with replacement (within project for per-project results, within pooled set for pooled), seed 20260511. Resample draws pooled pair rates.
- Headline = pooled over the five untouched projects. Per-project shown too.

## Baselines (same outcome, same pairs, same bootstrap)
(a) Assignee: item's current assignee == L (assigned) vs assignee != L (including unassigned). Difference = rate(assigned to L) - rate(not assigned to L). Assignee is the CURRENT assignee (history is not available in search; caveat).
(b) Count share, no decay: share = L's non-bot comments / all non-bot comments at time <= T, same thresholds (>=0.5 vs <0.25).

## Verdict rule (fixed in advance)
ADVANCE only if, on the untouched pooled set: the decayed-concentration difference is > 0 with 95% CI excluding 0, AND it is at least as large as baseline (a)'s difference AND not clearly worse than baseline (b) (its point estimate is >= (b)'s point estimate minus 0.02 - i.e. decay is not harmful). Otherwise STOP for the predictive claim; keep only the coverage claim.
Also stated up front: if fewer than 3 of 5 untouched projects show a positive point difference, report as not robust.

## Coverage metric
Count of pairs (L, I) with concentration >= 0.5 AND item's current assignee != L (unassigned or other), vs. concentration >= 0.5 AND assignee == L. Also the number of those where the item is unresolved (no resolutiondate) at T (resolutiondate null or > T).

## Pre-declared secondary (not used for the verdict)
Same primary contrast restricted to items unresolved at T.
