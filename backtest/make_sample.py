#!/usr/bin/env python3 -I
"""Builds app/src/sample/sample-org.json from the cached KAFKA Jira pages in backtest/cache.

Only structure survives: who commented / was assigned, and when. Comment text is read once to tag an
edge as 'reviewed' (LGTM-style) and to tell leaver profiles apart, and is never written out.
Everything else (names, titles, areas, teams, goals, priorities, due dates, links) is generated.
Deterministic: same cache -> same file. usage: python3 -I make_sample.py
"""
import glob, hashlib, json, os, random, re
from collections import Counter, defaultdict
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "app", "src", "sample", "sample-org.json")
PROJECT = "KAFKA"
SEED = 20261109
DAY, HOUR = 86400, 3600
WINDOW_DAYS, CLOSED_DAYS = 365, 60
N_PEOPLE_REAL = 32      # named people kept; the long tail folds into 3 community accounts
MAX_ITEMS = 480

BOT = re.compile(r"github|bot\b|jenkins|hudson|asf|qa$|subversion|jira", re.I)
REVIEW = re.compile(r"\blgtm\b|\+1\b|looks good|\bapproved?\b|\breview", re.I)
QA_WORDS = re.compile(r"\b(test|tests|flaky|repro|reproduc\w*|fail\w*|regression|ci|build|integration)\b", re.I)
PM_WORDS = re.compile(r"\b(kip|release|roadmap|priority|scope|plan|design|proposal|deprecat\w*|version|vote)\b", re.I)

def ts(s): return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%f%z").timestamp()

FIRST = """Aiko Bram Camille Dara Elif Farid Greta Hana Idris Jonas Kira Lena Mateo Nadia Orla Pavel Quinn Rhea Soren Tessa
Ulises Vera Wren Xavi Yara Zane Anselm Bianca Cedric Delia Emeka Freya Gael Hugo Ingrid Joaquin Kofi Livia Marek Noor
Odile Petra Rafael Saskia Tomas Uma Viktor Wanjiru Ximena Yusuf Zofia""".split()
LAST = """Abara Bellweather Castellan Dvorak Eklund Fontaine Garrido Halvorsen Ibarra Jankowski Kovalenko Lindqvist
Moreau Nakashima Okonkwo Petrov Quintero Rasmussen Santoro Thorne Uchida Valdez Whitlock Yilmaz Zielinski
Arvidsson Brandt Corrigan Delacroix Esposito Fairweather Gunnarsson Hartmann Iwata Jovanovic""".split()
AREAS = ["ingest", "scheduler", "storage-engine", "gateway", "auth", "billing-sync", "search-index", "admin-console"]
TEAMS = {"ingest": "Data Flow", "scheduler": "Data Flow", "storage-engine": "Platform", "gateway": "Platform",
         "auth": "Identity", "billing-sync": "Identity", "search-index": "Experience", "admin-console": "Experience"}
GOALS = [("Cut ingest lag below target", ["ingest", "scheduler"]), ("Storage engine upgrade", ["storage-engine"]),
         ("Gateway rate limits GA", ["gateway"]), ("SSO and token hygiene", ["auth"]),
         ("Billing reconciliation cleanup", ["billing-sync"]), ("Search relevance and admin tooling", ["search-index", "admin-console"])]
VERBS = ["Fix", "Handle", "Tighten", "Document", "Add tests for", "Speed up", "Clean up", "Investigate", "Harden", "Stop duplicate"]
THINGS = ["retry handling", "timeout behavior", "config validation", "error reporting", "batch sizing", "cache invalidation",
          "state cleanup", "startup checks", "metrics labels", "backoff logic", "permission checks", "pagination",
          "schema migration", "log noise", "shutdown ordering", "queue draining", "rebalance edge case", "null handling"]
SUFFIX = ["sync", "path", "worker", "client", "pipeline", "API", "job", "handler", "flow", "service"]

def load():
    iss = {}
    for f in glob.glob(os.path.join(HERE, "cache", "*.json")):
        for i in json.load(open(f))["issues"]:
            if i["key"].startswith(PROJECT + "-"): iss[i["key"]] = i
    return iss

def main():
    rng = random.Random(SEED)
    iss = load()
    A = max(ts(c["created"]) for i in iss.values() for c in i["fields"]["comment"]["comments"])
    A = int(-(-A // HOUR) * HOUR)  # baseline = latest activity in the cache = "now" in the sample
    sel = []
    for i in iss.values():
        f = i["fields"]; cr = ts(f["created"])
        if cr < A - WINDOW_DAYS * DAY: continue
        if f["resolutiondate"] and ts(f["resolutiondate"]) < A - CLOSED_DAYS * DAY: continue
        sel.append(i)
    # rank accounts by comment volume in the slice
    vol = Counter()
    for i in sel:
        for c in i["fields"]["comment"]["comments"]:
            n = c["author"]["name"]
            if not BOT.search(n) and not BOT.search(c["author"].get("displayName", "")): vol[n] += 1
    top = [n for n, _ in vol.most_common(N_PEOPLE_REAL)]
    names = list(top)
    combos = [f"{a} {b}" for a in FIRST for b in LAST]
    all_real = set()
    for i in iss.values():
        for c in i["fields"]["comment"]["comments"]: all_real.add(c["author"].get("displayName", "").lower())
        a = i["fields"].get("assignee")
        if a: all_real.add(a.get("displayName", "").lower())
    combos = [c for c in combos if c.lower() not in all_real]
    rng.shuffle(combos)
    pid = {n: f"p{k+1:02d}" for k, n in enumerate(names)}
    pname = {pid[n]: combos[k] for k, n in enumerate(names)}
    ext_ids = ["x1", "x2", "x3"]
    def person_of(name):
        if name in pid: return pid[name]
        return ext_ids[int(hashlib.sha256(("tail" + name).encode()).hexdigest(), 16) % 3]
    BOTID = "bot1"

    # edges per issue
    raw = {}
    for i in sel:
        f = i["fields"]; cr = ts(f["created"]); E = []; seen_other = {}
        asg = f.get("assignee"); asg_id = person_of(asg["name"]) if asg and not BOT.search(asg["name"]) else None
        if asg_id: E.append((asg_id, "assigned", min(cr + HOUR, A), ""))
        first_by = None
        for c in sorted(f["comment"]["comments"], key=lambda c: c["created"]):
            n = c["author"]["name"]; t = ts(c["created"]); body = c.get("body") or ""
            if BOT.search(n) or BOT.search(c["author"].get("displayName", "")):
                E.append((BOTID, "commented", t, body)); continue
            p = person_of(n)
            if REVIEW.search(body): k = "reviewed"
            elif asg_id and p == asg_id and first_by not in (None, p): k = "answered"
            else: k = "commented"
            if first_by is None: first_by = p
            E.append((p, k, t, body))
        raw[i["key"]] = (i, E, asg_id)

    # keep items with >=2 human edges, most recently active first, capped
    cand = []
    for key, (i, E, a) in raw.items():
        hum = [e for e in E if e[0] != BOTID]
        if len(hum) < 2: continue
        cand.append((max(e[2] for e in E), key))
    cand.sort(reverse=True)
    keep = [k for _, k in cand[:MAX_ITEMS]]
    keep.sort(key=lambda k: ts(raw[k][0]["fields"]["created"]))
    iid = {k: f"WRK-{101+n}" for n, k in enumerate(keep)}

    # voice per person per item (comment-type edges only, like the backtest) for leaver profiling
    voice, assigned_to = {}, {}
    for k in keep:
        _, E, a = raw[k]
        c = Counter(e[0] for e in E if e[1] != "assigned" and e[0] != BOTID)
        voice[k] = c; assigned_to[k] = a
    def mv(k, p):
        c = voice[k]; t = sum(c.values())
        return t > 0 and c.get(p, 0) / t >= 0.5
    stats = {}
    for n in top:
        p = pid[n]
        mine = [k for k in keep if mv(k, p) and not raw[k][0]["fields"]["resolutiondate"]]
        words = [b for k in keep for (q, kk, t, b) in raw[k][1] if q == p and kk != "assigned"]
        stats[p] = dict(mv=len(mine), asg=sum(1 for k in keep if assigned_to[k] == p),
                        qa=sum(bool(QA_WORDS.search(b)) for b in words) / max(1, len(words)),
                        pm=sum(bool(PM_WORDS.search(b)) for b in words) / max(1, len(words)),
                        comments=len(words))
    elig = [p for p, s in stats.items() if s["mv"] >= 8]
    qa = max(elig, key=lambda p: stats[p]["qa"])
    elig2 = [p for p in elig if p != qa]
    pm = max(elig2, key=lambda p: stats[p]["pm"] - 0.02 * stats[p]["asg"])
    elig3 = [p for p in elig2 if p != pm]
    def na_share(p):
        ks = [k for k in keep if mv(k, p) and not raw[k][0]["fields"]["resolutiondate"]]
        return sum(assigned_to[k] != p for k in ks) / max(1, len(ks))
    # engineer = most-assigned person whose main-voice items are still mostly unassigned (>=75%)
    elig_e = [p for p in elig3 if stats[p]["asg"] >= 3 and na_share(p) >= 0.75] or elig3
    eng = max(elig_e, key=lambda p: stats[p]["asg"])
    if os.environ.get("DEBUG"):
        for p in sorted(stats, key=lambda p: -stats[p]["mv"])[:14]: print(p, stats[p], round(na_share(p), 2))
    leavers = [{"personId": eng, "profile": "engineer"}, {"personId": pm, "profile": "pm"}, {"personId": qa, "profile": "qa"}]

    # areas: home area per person, item area = area of its biggest human voice
    homes = {p: AREAS[int(hashlib.sha256(("home" + p).encode()).hexdigest(), 16) % len(AREAS)] for p in pid.values()}
    leader_areas = [homes[l["personId"]] for l in leavers]
    # make sure the three leavers sit in different areas so plans differ
    used = set()
    for l in leavers:
        p = l["personId"]
        if homes[p] in used: homes[p] = next(a for a in AREAS if a not in used and a not in leader_areas[1:] or a not in used)
        used.add(homes[p])
    for x in ext_ids: homes[x] = AREAS[int(hashlib.sha256(x.encode()).hexdigest(), 16) % len(AREAS)]
    area_of = {}
    for k in keep:
        c = voice[k]
        main = c.most_common(1)[0][0] if c else (assigned_to[k] or "x1")
        area_of[k] = homes.get(main, AREAS[0])

    def off(t): return int(round((t - A) / HOUR)) * HOUR * 1000
    items, edges = [], []
    cnt_by = {k: len(raw[k][1]) for k in keep}
    for k in keep:
        i, E, a = raw[k]; f = i["fields"]
        open_ = not f["resolutiondate"]
        n = cnt_by[k]
        r = rng.random() + min(0.25, n * 0.015)
        pr = "highest" if r > 1.12 else "high" if r > 0.9 else "medium" if r > 0.45 else "low" if r > 0.12 else "lowest"
        it = {"id": iid[k], "kind": "workItem", "area": area_of[k], "open": open_,
              "title": f"{rng.choice(VERBS)} {rng.choice(THINGS)} in {area_of[k]} {rng.choice(SUFFIX)}", "priority": pr}
        if open_ and rng.random() < 0.24:
            it["dueOff"] = rng.randint(-14, 75) * DAY * 1000
        items.append(it)
        for (p, kind, t, _) in E:
            edges.append([p, iid[k], kind, off(t)])
    # goals
    gid = {}
    for g, (title, areas) in enumerate(GOALS):
        gid[g] = f"GOAL-{g+1}"
        items.append({"id": gid[g], "kind": "goal", "title": title, "open": True})
        inarea = [it for it in items if it["kind"] == "workItem" and it["area"] in areas]
        for it in inarea:
            if rng.random() < 0.75: it["goal"] = gid[g]
        votes = Counter(e[0] for e in edges if e[1] in {x["id"] for x in inarea} and e[0] not in (BOTID,) + tuple(ext_ids))
        if votes: edges.append([votes.most_common(1)[0][0], gid[g], "owns", -150 * DAY * 1000])
    # links / blocks (synthetic, same area, open items)
    openw = [it for it in items if it["kind"] == "workItem" and it["open"]]
    byarea = defaultdict(list)
    for it in openw: byarea[it["area"]].append(it)
    for a, L in byarea.items():
        for j, it in enumerate(L):
            if len(L) < 3: break
            if rng.random() < 0.22:
                o = rng.choice(L)
                if o["id"] != it["id"] and o["id"] not in it.get("links", []): it.setdefault("links", []).append(o["id"])
            if rng.random() < 0.09 and j + 1 < len(L):
                o = L[rng.randrange(j + 1, len(L))]
                it.setdefault("blocks", []).append(o["id"])

    # people
    open_asg = Counter(assigned_to[k] for k in keep if not raw[k][0]["fields"]["resolutiondate"] and assigned_to[k])
    people = []
    for n in top:
        p = pid[n]
        people.append({"id": p, "name": pname[p], "team": TEAMS[homes[p]],
                       "load": round(min(0.95, 0.12 + 0.07 * open_asg[p]), 2)})
    on_leave = [p["id"] for p in people if p["id"] not in {l["personId"] for l in leavers}][-2:]
    for p in people:
        if p["id"] in on_leave: p["active"] = False
    for x, nm in zip(ext_ids, ["Community contributor A", "Community contributor B", "Community contributor C"]):
        people.append({"id": x, "name": nm, "team": "Community", "load": 0.95})
    people.append({"id": BOTID, "name": "Build Bot", "isBot": True})
    used_people = {e[0] for e in edges}
    people = [p for p in people if p["id"] in used_people]

    # measured finding: of open items where a leaver is the main voice (>=50% of human comment-type
    # contributions), how many are not assigned to them
    def share(group):
        tot = na = 0
        for l in group:
            p = l["personId"]
            for k in keep:
                if raw[k][0]["fields"]["resolutiondate"] or not mv(k, p): continue
                tot += 1; na += assigned_to[k] != p
        return tot, na
    per = {}
    for l in leavers:
        t, na = share([l]); per[l["personId"]] = {"profile": l["profile"], "mainVoiceOpenItems": t, "notAssigned": na,
                                                  "notAssignedShare": round(na / t, 3) if t else None,
                                                  "assignedItems": stats[l["personId"]]["asg"], "comments": stats[l["personId"]]["comments"]}
    t, na = share(leavers)
    at, ana = share([{"personId": p} for p in stats])  # everyone named, no selection

    def clean(d): return {k: v for k, v in d.items()}
    meta = {
        "sourceProject": "Apache Kafka (KAFKA) public Jira issue metadata, fetched via the Jira REST API",
        "license": "Apache Software Foundation public project data; the Apache Kafka project is Apache-2.0 and its Jira tracker is public. Attribution: derived from issues.apache.org Jira, project KAFKA. Not endorsed by the ASF.",
        "transform": "Kept only structure from a 12-month slice (open issues plus issues resolved in the last 60 days): who commented or was assigned and when. Comment text is dropped entirely. People are replaced by generated fictional names (deterministic mapping, no source name reused); the long tail of commenters is folded into 3 'Community contributor' accounts; bot accounts become one 'Build Bot'. Titles are generated from templates. Issue keys are renumbered. Timestamps are stored as millisecond offsets from the latest activity (0 = now, negative = past), rounded to the hour, and rebased to Date.now() by loadSample. The source cache had no reporter, component, priority, due date or link data, so areas, priorities, due dates and links/blocks are synthetic.",
        "syntheticDisclosure": "Goals, teams, areas, priorities, due dates, links and blocks, loads, the two on-leave people and the owner edges on goals are synthetic. Assigned-edge times are set to just after the issue was created because the cache has no assignment history. 'authored' edges do not exist because the cache has no reporter field. Roles of the three leavers are labels chosen from comment behaviour, not real job titles.",
        "counts": {"people": len(people), "items": len(items), "workItems": sum(1 for i in items if i["kind"] == "workItem"),
                   "openWorkItems": sum(1 for i in items if i["kind"] == "workItem" and i["open"]),
                   "goals": len(GOALS), "teams": len({p.get("team") for p in people if p.get("team") != "Community" and p.get("team")}),
                   "edges": len(edges)},
        "leavers": [{"personId": l["personId"], "profile": l["profile"], **per[l["personId"]]} for l in leavers],
        "measuredNotAssignedShare": {"definition": "open work items where the leaver holds >=50% of human comment/review contributions and is not the assignee, over all open items where they hold >=50%",
                                     "items": t, "notAssigned": na, "share": round(na / t, 3) if t else None,
                                     "selectionNote": "The engineer leaver was picked as the most-assigned person with >=75% of main-voice items unassigned, so the leaver figure is selected, not a population estimate.",
                                     "allNamedPeople": {"items": at, "notAssigned": ana, "share": round(ana / at, 3) if at else None}},
    }
    out = {"metadata": meta, "people": people, "leavers": leavers, "items": items, "edges": edges}
    def lines(a): return "[\n" + ",\n".join(json.dumps(x, separators=(",", ":")) for x in a) + "\n]"
    with open(OUT, "w") as fh:
        fh.write("{\n\"metadata\":" + json.dumps(meta, indent=1) + ",\n\"people\":" + lines(people) + ",\n\"leavers\":" + lines(leavers)
                 + ",\n\"items\":" + lines(items) + ",\n\"edges\":" + lines(edges) + "\n}\n")
    print(json.dumps(meta["counts"]))
    for l in meta["leavers"]: print(l)
    print("not-assigned share (all named people, unselected):", at, ana, round(ana / at, 3))
    print("not-assigned share (leavers pooled, computed):", t, na, round(na / t, 3) if t else None)

main()
