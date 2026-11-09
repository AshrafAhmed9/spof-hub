#!/usr/bin/env python3 -I
"""Knowledge-concentration backtest. See DEFINITIONS.md (frozen before running).
usage: python3 -I run.py --projects SPARK CASSANDRA ... [--label untouched|development] [--out results_x.json]
"""
import argparse, hashlib, json, os, random, re, sys, time, urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
BASE = "https://issues.apache.org/jira/rest/api/2/search"
WIN_START, WIN_END = "2018-01-01", "2023-06-30"
TAIL_START = "2023-07-01"
HALF_LIFE = 180 * 86400
MIN_COMMENTS = 30
DAY = 86400
SEED = 20260511
last_req = [0.0]

BOT_NAME = re.compile(r"asf github bot|asf subversion|hudson|jenkins|jira-bot|jira bot|hadoop qa|hive qa|sparkqa|"
                      r"amplabjenkins|githubbot|\bbot\b|qa bot|build bot|ci-bot|apachespark|snyk|dependabot|"
                      r"github-actions|asfbot|git services|subversion and git", re.I)
BOT_BODY = re.compile(r"Integrated in .{0,80}build|Commit [0-9a-f]{7,} in|User '.*?' has created a pull request|"
                      r"GitHub user .*? has created a pull request|Github user|Can one of the admins verify this patch|"
                      r"Test build #|\|\s*Vote\s*\||-1 overall|\+1 overall|Merged build finished|Test PASSed|Test FAILed|"
                      r"Build succeeded|Build failed|Closing this PR|Issue resolved by pull request|"
                      r"This issue has been automatically marked", re.I)

def ts(s):
    # '2020-01-02T03:04:05.000+0000'
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%f%z").timestamp()

def fetch(jql, start, size=100):
    url = BASE + "?" + urllib.parse.urlencode({"jql": jql, "startAt": start, "maxResults": size,
                                               "fields": "comment,assignee,created,resolutiondate"})
    f = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest() + ".json")
    if os.path.exists(f):
        return json.load(open(f))
    for attempt in range(6):
        wait = 0.55 - (time.time() - last_req[0])
        if wait > 0: time.sleep(wait)
        last_req[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "backtest-research/1.0"}), timeout=90) as r:
                d = json.loads(r.read())
            tmp = f + ".tmp"
            json.dump(d, open(tmp, "w")); os.replace(tmp, f)
            return d
        except Exception as e:
            print("retry", attempt, e, file=sys.stderr); time.sleep(5 * (attempt + 1))
    raise RuntimeError("fetch failed " + url)

def fetch_all(jql):
    out, start = [], 0
    while True:
        d = fetch(jql, start)
        out += d["issues"]
        start += len(d["issues"])
        if not d["issues"] or start >= d["total"]: break
        if start % 2000 == 0: print("  ", start, "/", d["total"], file=sys.stderr, flush=True)
    return out

def person(a):
    if not a: return None
    return a.get("name") or a.get("key") or a.get("displayName")

def is_bot(c):
    a = c.get("author") or {}
    if BOT_NAME.search((a.get("name") or "") + " " + (a.get("displayName") or "")): return True
    return bool(BOT_BODY.search(c.get("body") or ""))

def parse_issue(iss):
    f = iss["fields"]; cm = f["comment"]
    comments, trunc = [], cm.get("total", 0) > len(cm["comments"])
    for c in cm["comments"]:
        p = person(c.get("author"))
        if p is None or is_bot(c): continue
        comments.append((ts(c["created"]), p))
    comments.sort()
    return {"key": iss["key"], "created": ts(f["created"]), "assignee": person(f.get("assignee")),
            "resolved": ts(f["resolutiondate"]) if f.get("resolutiondate") else None,
            "comments": comments, "trunc": trunc}

def load_project(p):
    win = fetch_all(f'project = {p} AND created >= "{WIN_START}" AND created <= "{WIN_END}" ORDER BY created ASC')
    tail = fetch_all(f'project = {p} AND created >= "{TAIL_START}" ORDER BY created ASC')
    return [parse_issue(i) for i in win], [parse_issue(i) for i in tail]

def build_pairs(items, tail, fetch_end):
    cnt, last = defaultdict(int), {}
    for it in items:
        for t, p in it["comments"]:
            cnt[p] += 1
            if t > last.get(p, 0): last[p] = t
    for it in tail:
        for t, p in it["comments"]:
            if t > last.get(p, 0): last[p] = t
    leavers = {p: last[p] for p in cnt if cnt[p] >= MIN_COMMENTS and last[p] <= fetch_end - 365 * DAY}
    pairs, dropped = [], 0
    for it in items:
        cs = it["comments"]
        for L, T in leavers.items():
            if it["created"] >= T: continue
            pre = [(t, p) for t, p in cs if t <= T]
            if not any(p == L for _, p in pre): continue
            post = [(t, p) for t, p in cs if T < t <= T + 365 * DAY]
            if not post: dropped += 1; continue
            w = [(0.5 ** ((T - t) / HALF_LIFE), p) for t, p in pre]
            conc = sum(x for x, p in w if p == L) / sum(x for x, _ in w)
            share = sum(1 for _, p in pre if p == L) / len(pre)
            t1, p1 = post[0]
            answered = any(p != p1 and t1 < t <= t1 + 30 * DAY for t, p in cs)
            pairs.append({"L": L, "key": it["key"], "conc": conc, "share": share,
                          "assigned": it["assignee"] == L, "unans": 0 if answered else 1,
                          "unresolved": it["resolved"] is None or it["resolved"] > T})
    return pairs, leavers, dropped

def rate(rows):
    return sum(r["unans"] for r in rows) / len(rows) if rows else float("nan")

CONTRASTS = {
    "decayed_conc": (lambda r: r["conc"] >= 0.5, lambda r: r["conc"] < 0.25),
    "count_share": (lambda r: r["share"] >= 0.5, lambda r: r["share"] < 0.25),
    "assignee": (lambda r: r["assigned"], lambda r: not r["assigned"]),
}

def contrast(pairs, name):
    hi, lo = CONTRASTS[name]
    H = [r for r in pairs if hi(r)]; Lw = [r for r in pairs if lo(r)]
    return rate(H), rate(Lw), len(H), len(Lw)

def boot(pairs, name, n=2000):
    by = defaultdict(list)
    for r in pairs: by[r["L"]].append(r)
    people = list(by); rng = random.Random(SEED); hi, lo = CONTRASTS[name]
    # per-person sufficient stats: (hiN, hiU, loN, loU)
    st = {}
    for L, rs in by.items():
        h = [r for r in rs if hi(r)]; l = [r for r in rs if lo(r)]
        st[L] = (len(h), sum(r["unans"] for r in h), len(l), sum(r["unans"] for r in l))
    ds = []
    for _ in range(n):
        a = [0, 0, 0, 0]
        for _ in people:
            s = st[rng.choice(people)]
            for i in range(4): a[i] += s[i]
        if a[0] and a[2]: ds.append(a[1] / a[0] - a[3] / a[2])
    ds.sort()
    if len(ds) < n * 0.9 or not ds: return None, None
    return ds[int(0.025 * len(ds))], ds[int(0.975 * len(ds)) - 1]

def summarize(pairs):
    out = {}
    for name in CONTRASTS:
        rh, rl, nh, nl = contrast(pairs, name)
        lo, hi = boot(pairs, name)
        hi_f, lo_f = CONTRASTS[name]
        out[name] = {"rate_hi": rh, "rate_lo": rl, "n_hi": nh, "n_lo": nl, "diff": rh - rl if nh and nl else None,
                     "ci": [lo, hi], "leavers_hi": len({r["L"] for r in pairs if hi_f(r)}),
                     "leavers_lo": len({r["L"] for r in pairs if lo_f(r)})}
    mid = [r for r in pairs if 0.25 <= r["conc"] < 0.5]
    out["middle_0.25_0.5"] = {"n": len(mid), "rate": rate(mid)}
    hi = [r for r in pairs if r["conc"] >= 0.5]
    out["coverage"] = {"conc_hi": len(hi), "hi_not_assigned_to_leaver": sum(not r["assigned"] for r in hi),
                       "hi_assigned_to_leaver": sum(r["assigned"] for r in hi),
                       "hi_not_assigned_and_unresolved_at_T": sum((not r["assigned"]) and r["unresolved"] for r in hi)}
    un = [r for r in pairs if r["unresolved"]]
    rh, rl, nh, nl = contrast(un, "decayed_conc")
    lo, hi_ = boot(un, "decayed_conc")
    out["secondary_unresolved_at_T"] = {"rate_hi": rh, "rate_lo": rl, "n_hi": nh, "n_lo": nl,
                                        "diff": rh - rl if nh and nl else None, "ci": [lo, hi_]}
    out["n_pairs"] = len(pairs); out["n_leavers_in_pairs"] = len({r["L"] for r in pairs})
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--projects", nargs="+", required=True)
    ap.add_argument("--label", default="untouched")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(CACHE, exist_ok=True)
    fetch_end = time.time()
    res = {"label": a.label, "fetch_date": datetime.now(timezone.utc).isoformat(), "window": [WIN_START, WIN_END], "projects": {}}
    allp = []
    for p in a.projects:
        print("loading", p, file=sys.stderr, flush=True)
        items, tail = load_project(p)
        pairs, leavers, dropped = build_pairs(items, tail, fetch_end)
        for r in pairs: r["L"] = p + ":" + r["L"]
        allp += pairs
        s = summarize(pairs)
        s.update({"n_items": len(items), "n_tail_items": len(tail), "n_leavers": len(leavers),
                  "dropped_no_post_comment": dropped,
                  "truncated_comment_items": sum(i["trunc"] for i in items)})
        res["projects"][p] = s
        print(p, json.dumps(s["decayed_conc"]), file=sys.stderr, flush=True)
    res["pooled"] = summarize(allp)
    json.dump(res, open(os.path.join(HERE, a.out), "w"), indent=1)

if __name__ == "__main__":
    main()
