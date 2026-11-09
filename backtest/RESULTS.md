# Results

Protocol: DEFINITIONS.md, written and frozen before `run.py` was run on the untouched projects. Data fetched 2026-11-09 (cache in `cache/`, gitignored). Raw output: `results_untouched.json`, `results_development.json`, `results_sensitivity.json`.
Item window created 2018-01-01..2023-06-30 for all projects, no project needed a tighter cap. Departed-person activity was also checked on issues created after 2023-06-30 (tail). BEAM has no tail issues (it moved to GitHub Issues in mid-2023), so BEAM leavers cannot be ruled out as still active there.

## Verdict

**Stop on the predictive claim. Keep the coverage claim.**

By the rule fixed in advance, concentration did not advance: pooled over the five untouched projects, the decayed-concentration difference is +0.092 (95% CI +0.028 to +0.134), which is positive and beats the assignee baseline (-0.040), but it is worse than the plain comment-count share (+0.120) by more than the 0.02 tolerance. Time decay adds nothing; it is slightly worse. The pooled number is also 78% BEAM pairs, and BEAM is distorted (see caveats). Direction is consistent (4 of 5 untouched projects positive, 3 of 3 development projects positive), but only SPARK and BEAM have CIs that exclude zero on their own.

## Headline: untouched, pooled (unanswered-for-30-days rate)

| Measure | High | Low | n high / low (pairs) | leavers high / low | Diff | 95% CI |
|---|---|---|---|---|---|---|
| Decayed concentration (>=.5 vs <.25) | 0.936 | 0.844 | 1416 / 810 | 207 / 154 | +0.092 | +0.028, +0.134 |
| Baseline b: count share, no decay | 0.933 | 0.813 | 1661 / 599 | 219 / 146 | +0.120 | +0.073, +0.159 |
| Baseline a: assignee == leaver vs not | 0.862 | 0.901 | 159 / 2813 | 97 / 245 | -0.040 | -0.120, +0.054 |

2972 pairs, 264 leavers. Middle bucket (0.25 to 0.5): n=746, rate 0.887.

## Per project, untouched (decayed concentration; baselines in brackets)

| Project | items | leavers (>=30 cmts, departed) | pairs | high rate / n | low rate / n | Diff (95% CI) | b: count share diff | a: assignee diff |
|---|---|---|---|---|---|---|---|---|
| SPARK | 21293 | 73 | 157 | 0.810 / 58 | 0.536 / 56 | +0.275 (+0.112, +0.447) | +0.227 (+0.056, +0.413) | -0.080 (-0.461, +0.294), n=8 assigned |
| CASSANDRA | 4452 | 46 | 127 | 0.586 / 29 | 0.450 / 60 | +0.136 (-0.071, +0.374) | +0.152 (-0.052, +0.362) | +0.228 (-0.033, +0.493) |
| HIVE | 9087 | 78 | 183 | 0.762 / 80 | 0.766 / 47 | -0.003 (-0.156, +0.158) | +0.012 (-0.164, +0.177) | +0.179 (+0.063, +0.288) |
| IGNITE | 12522 | 71 | 179 | 0.737 / 99 | 0.590 / 39 | +0.148 (-0.027, +0.313) | +0.179 (+0.012, +0.391) | +0.149 (-0.048, +0.352) |
| BEAM | 11152 | 70 | 2326 | 0.981 / 1150 | 0.934 / 608 | +0.047 (+0.009, +0.077) | +0.053 (+0.018, +0.089) | -0.004 (-0.083, +0.063) |

Per-project, concentration is not consistently better than the assignee baseline: assignee has the larger point estimate in CASSANDRA and HIVE (and HIVE's CI excludes zero), concentration in SPARK. Samples are small (high/low buckets of 30 to 100 per project outside BEAM).

## Development (KAFKA, FLINK, HBASE): not used for the verdict

| Project | pairs | high rate / n | low rate / n | Decayed diff (95% CI) | b: count share | a: assignee |
|---|---|---|---|---|---|---|
| KAFKA | 230 | 0.899 / 79 | 0.705 / 78 | +0.194 (+0.062, +0.296) | +0.201 | -0.065 (-0.387, +0.222) |
| FLINK | 796 | 0.800 / 245 | 0.663 / 303 | +0.137 (+0.066, +0.204) | +0.133 | +0.080 (-0.021, +0.167) |
| HBASE | 203 | 0.836 / 61 | 0.578 / 83 | +0.258 (+0.107, +0.391) | +0.269 | +0.093 (-0.038, +0.216) |
| Pooled | 1229 | 0.826 / 385 | 0.655 / 464 | +0.171 (+0.113, +0.224) | +0.168 (+0.113, +0.218) | +0.058 (-0.018, +0.128) |

These rates differ from the earlier probes (Kafka .91/.62, HBase .65/.50, Flink .80/.76) because the definitions differ (decay, departure rule, bot filter). Note the Flink gap is now larger than in the probe.

## Coverage (the claim that survives)

Pairs where the departed person holds >=50% of decayed comment weight, split by whether they are the current assignee:

| Set | high-concentration pairs | not assigned to leaver | assigned to leaver | not assigned and unresolved at T |
|---|---|---|---|---|
| Untouched pooled | 1416 | 1317 (93%) | 99 | 1291 |
| Untouched pooled ex-BEAM (post hoc) | 266 | 201 (76%) | 65 | 176 |
| SPARK | 58 | 53 | 5 | 44 |
| CASSANDRA | 29 | 23 | 6 | 20 |
| HIVE | 80 | 47 | 33 | 39 |
| IGNITE | 99 | 78 | 21 | 73 |
| BEAM | 1150 | 1116 | 34 | 1115 |
| Development pooled | 385 | 327 (85%) | 58 | 319 |

An assignee-based tool sees roughly 7 to 41% of these items. The split holds across all eight projects (HIVE is the lowest at 59%). Caveat: assignee is the current assignee, not the assignee at departure.

## Caveats

- BEAM distorts the pooled number. It contributes 2326 of 2972 pairs, its unanswered rate is 93 to 98% in both buckets (ceiling effect), and its first post-departure comment is often the bot-like "This issue has been migrated to https://github.com/..." notice from a human account, which my frozen bot filter did not catch. Post hoc (not part of the frozen protocol, `sensitivity.py`):
  - Pooled ex-BEAM: decayed +0.170 (+0.085, +0.260), count share +0.177 (+0.094, +0.271), assignee +0.176 (+0.085, +0.260), n 266/202 pairs. Concentration is not better than the assignee baseline here; they are the same size.
  - BEAM with migration notices dropped: decayed +0.139 (-0.002, +0.283), count share +0.135, assignee +0.192 (+0.028, +0.296), n 98/96. The BEAM signal shrinks to noise-level significance.
  - Pooled with BEAM cleaned: decayed +0.156 (+0.081, +0.236), count share +0.167 (+0.094, +0.242), assignee +0.167 (+0.091, +0.237).
  Under any version, decayed concentration is no better than count share or assignee. The frozen verdict stands; these checks were run after seeing the results and should not be used to rescue the claim.
- Unanswered rates are high everywhere (50 to 98%), partly because the outcome counts any first post-departure comment, not only questions. The definition is as frozen; a "question" detector was not added.
- Many pairs (about 5k to 10k per project) were dropped because no human comment followed within 365 days. The analysed items are the ones that got attention after the leaver left, which biases toward live items.
- Pairs from the same leaver are correlated; the bootstrap clusters by leaver, but the CI is over only 30 to 70 leavers per project.
- Departure is inferred from comments only (items created 2018 on). Someone who stayed active through other channels (commits, mailing list, issues before 2018, BEAM after the GitHub move) can be misclassified as departed. Account renames or multiple accounts are not merged.
- Bot filter is name and template based; it is imperfect (BEAM migration notice above). Hive/Spark QA templates were caught by name and pattern but not audited line by line.
- No multiple-comparison correction; no per-leaver covariates (seniority, item age, priority, component) were adjusted for, so the concentration effect could be confounded by item type or activity level.
