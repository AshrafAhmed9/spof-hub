"""Metrics and bootstrap CIs for the successor backtest (DEFINITIONS_SUCCESSOR.md). Reads ranks_<P>.json."""
import json, os, random, sys
from collections import defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = ["SPARK", "CASSANDRA", "HIVE", "IGNITE", "BEAM"]
METHODS = ["engine", "active", "topOnItem", "lastOnItem", "random"]
SEED = 20260512

def load():
    rows = []
    for p in PROJECTS:
        for r in json.load(open(os.path.join(HERE, f"ranks_{p}.json"))):
            r["project"] = p; r["leaver"] = p + ":" + r["L"]; rows.append(r)
    return rows

def metric(r, m, k):
    n = r["n"]
    if m == "random": return min(k, n) / n
    return 1.0 if r[m] <= k else 0.0

def mrr(r, m):
    n = r["n"]
    if m == "random": return sum(1 / i for i in range(1, n + 1)) / n
    return 1 / r[m]

def mean(rows, f): return sum(f(r) for r in rows) / len(rows) if rows else float("nan")

def boot(rows, stat, n=2000):
    by = defaultdict(list)
    for r in rows: by[r["leaver"]].append(r)
    ids = sorted(by); rng = random.Random(SEED); vals = []
    for _ in range(n):
        s = []
        for _ in ids: s += by[rng.choice(ids)]
        vals.append(stat(s))
    vals.sort()
    return vals[int(0.025 * n)], vals[int(0.975 * n)]

def block(rows):
    out = {"n_pairs": len(rows), "n_leavers": len({r["leaver"] for r in rows}), "mean_pool": round(mean(rows, lambda r: r["n"]), 1)}
    for m in METHODS:
        out[m] = {"hit1": mean(rows, lambda r: metric(r, m, 1)), "hit3": mean(rows, lambda r: metric(r, m, 3)), "mrr": mean(rows, lambda r: mrr(r, m))}
        out[m]["hit3_ci"] = boot(rows, lambda s: mean(s, lambda r: metric(r, m, 3)))
    for other in ["active", "topOnItem", "lastOnItem"]:
        d = lambda s, o=other: mean(s, lambda r: metric(r, "engine", 3)) - mean(s, lambda r: metric(r, o, 3))
        out[f"engine_minus_{other}_hit3"] = {"diff": d(rows), "ci": boot(rows, d)}
    return out

def main():
    rows = load()
    res = {"pooled": block(rows), "projects": {p: block([r for r in rows if r["project"] == p]) for p in PROJECTS},
           "item_had_other_commenters": block([r for r in rows if r["itemHadOthers"]]),
           "item_had_no_other_commenters": block([r for r in rows if not r["itemHadOthers"]]),
           "pickup_person_touched_item_before": block([r for r in rows if r["pTouchedItem"]]),
           "pickup_person_new_to_item": block([r for r in rows if not r["pTouchedItem"]]),
           "pooled_ex_beam": block([r for r in rows if r["project"] != "BEAM"])}
    json.dump(res, open(os.path.join(HERE, "results_successor.json"), "w"), indent=1)
    def line(name, b):
        print(f"{name:34s} n={b['n_pairs']:4d}/{b['n_leavers']:3d} pool~{b['mean_pool']:5.0f} " + " | ".join(
            f"{m[:6]} h1 {b[m]['hit1']:.2f} h3 {b[m]['hit3']:.2f} mrr {b[m]['mrr']:.2f}" for m in METHODS))
    for k, b in [("pooled", res["pooled"]), ("pooled ex BEAM", res["pooled_ex_beam"])] + list(res["projects"].items()) + [
        ("item had other commenters", res["item_had_other_commenters"]), ("item had none", res["item_had_no_other_commenters"]),
        ("pickup touched item before", res["pickup_person_touched_item_before"]), ("pickup new to item", res["pickup_person_new_to_item"])]:
        line(k, b)
    for o in ["active", "topOnItem", "lastOnItem"]:
        d = res["pooled"][f"engine_minus_{o}_hit3"]; print("pooled engine-" + o, round(d["diff"], 3), [round(x, 3) for x in d["ci"]])

if __name__ == "__main__":
    main()
