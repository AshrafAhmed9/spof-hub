#!/usr/bin/env python3 -I
"""POST-HOC sensitivity checks (not part of the frozen protocol). Reads cache only."""
import json, re, time, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run
MIG = re.compile(r"has been migrated to|migrated to https://github.com|moved to GitHub", re.I)
def load(p, drop_mig):
    items, tail = run.load_project(p)
    if drop_mig:
        for it in items + tail: it["comments"] = it["comments"]  # filtered below via raw body
    return items, tail
out = {}
end = time.time()
allp, allp_nomig = [], []
for p in ["SPARK", "CASSANDRA", "HIVE", "IGNITE", "BEAM"]:
    items, tail = run.load_project(p)
    pairs, _, _ = run.build_pairs(items, tail, end)
    for r in pairs: r["L"] = p + ":" + r["L"]
    allp += pairs
    out[p] = pairs
# BEAM with migration notices removed: patch is_bot then reparse
orig = run.is_bot
run.is_bot = lambda c: orig(c) or bool(MIG.search(c.get("body") or ""))
items, tail = run.load_project("BEAM")
bp, _, _ = run.build_pairs(items, tail, end)
for r in bp: r["L"] = "BEAM:" + r["L"]
res = {}
res["pooled_ex_BEAM"] = run.summarize([r for r in allp if not r["L"].startswith("BEAM:")])
res["BEAM_migration_notices_removed"] = run.summarize(bp)
res["pooled_with_BEAM_nomig"] = run.summarize([r for r in allp if not r["L"].startswith("BEAM:")] + bp)
json.dump(res, open("results_sensitivity.json", "w"), indent=1)
for k, v in res.items():
    print(k, v["n_pairs"])
    for n in ("decayed_conc", "count_share", "assignee"):
        d = v[n]; print("  ", n, "hi %.3f lo %.3f diff %.3f ci [%.3f,%.3f] n %d/%d L %d/%d" % (d["rate_hi"], d["rate_lo"], d["diff"], d["ci"][0], d["ci"][1], d["n_hi"], d["n_lo"], d["leavers_hi"], d["leavers_lo"]))
    print("   cov", v["coverage"])
