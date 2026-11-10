"""Builds the inputs for the successor backtest (DEFINITIONS_SUCCESSOR.md) from the cached Apache data.
No network: every request was cached by run.py. Writes succ_<PROJECT>.json for rank_successor.ts."""
import json, os, random, sys
from datetime import datetime
from run import load_project, MIN_COMMENTS, DAY, HERE

SEED = 20260512
MAX_PER_LEAVER = 8
POOL_DAYS = 180
FETCH_END = datetime.fromisoformat(json.load(open(os.path.join(HERE, "results_untouched.json")))["fetch_date"]).timestamp()

def export(project):
    items, tail = load_project(project)
    from collections import defaultdict
    cnt, last = defaultdict(int), {}
    for it in items:
        for t, p in it["comments"]:
            cnt[p] += 1; last[p] = max(last.get(p, 0), t)
    for it in tail:
        for t, p in it["comments"]: last[p] = max(last.get(p, 0), t)
    leavers = {p: last[p] for p in cnt if cnt[p] >= MIN_COMMENTS and last[p] <= FETCH_END - 365 * DAY}
    rng = random.Random(f"{SEED}:{project}")
    pairs, dropped = [], {"no_post_comment": 0, "target_not_in_pool": 0, "share_below_half": 0}
    for L in sorted(leavers):
        T = leavers[L]
        pool = sorted({p for it in items for t, p in it["comments"] if T - POOL_DAYS * DAY < t <= T} - {L})
        poolset = set(pool)
        cand = []
        for it in items:
            if it["created"] >= T: continue
            pre = [(t, p) for t, p in it["comments"] if t <= T]
            if not any(p == L for _, p in pre): continue
            if sum(1 for _, p in pre if p == L) / len(pre) < 0.5: dropped["share_below_half"] += 1; continue
            cand.append(it["key"])
        rng.shuffle(cand)
        by = {it["key"]: it for it in items}
        kept = 0
        for key in cand:
            if kept >= MAX_PER_LEAVER: break
            it = by[key]
            post = [(t, p) for t, p in it["comments"] if T < t <= T + 365 * DAY]
            if not post: dropped["no_post_comment"] += 1; continue
            P = post[0][1]
            if P not in poolset: dropped["target_not_in_pool"] += 1; continue
            pairs.append({"L": L, "T": T, "key": key, "P": P}); kept += 1
    json.dump({"project": project, "items": [{"key": i["key"], "created": i["created"], "comments": i["comments"]} for i in items],
               "pairs": pairs, "pool_days": POOL_DAYS, "n_leavers": len(leavers), "dropped": dropped},
              open(os.path.join(HERE, f"succ_{project}.json"), "w"))
    print(project, len(items), "items", len(leavers), "leavers", len(pairs), "pairs", dropped, file=sys.stderr)

if __name__ == "__main__":
    for p in sys.argv[1:]: export(p)
