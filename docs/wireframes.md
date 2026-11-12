# Wireframes and information architecture

Working name TBD. Plain-language copy only in the main UI. Raw scores live in a tooltip or "Why" drawer. Scores attach to work and areas, never a ranked list of people.
Component and token names are Atlassian Design System as I know them; confirm exact names and APIs at atlassian.design before building.

## Information architecture

```
Coverage hub (home)
 |- Sample-org banner (if sample mode)
 |- Setup check (link, collapses when OK)
 +- Area (component / epic / space / goal)
     +- Item (issue or page)
         |- Why drawer (signal breakdown, numbers here)
         +- Person plan (entered from a person + dates, or from an item)
             |- Review proposed cover
             |- Apply (preview, progress, results)
             |- Re-scan
             +- Audit log and Undo
Jira issue panel -> deep link to Item / Person plan
Rovo agent reply -> deep link to Item / Person plan
```

Nav: top-level tabs Coverage, Plans, Activity, Setup. Breadcrumb: Coverage / Area / Item.

## 1. Coverage hub

```
+--------------------------------------------------------------------+
| [Sample data] This is example data. Real changes are off.  [Use my site] |
+--------------------------------------------------------------------+
| Coverage                                   [Plan time off or leaving] |
| Where work depends on one person                                   |
| Filter: Project [All v]  Type [All v]  Show [Needs attention v]    |
+--------------------------------------------------------------------+
| Area              What's at risk                 Covered by         |
| Payments service  7 items only Priya has         1 person   [Open >]|
|                   answered. 2 are due this month.                   |
| Onboarding docs   4 pages only Sam has edited    1 person   [Open >]|
| Q1 Reliability    Goal depends on 3 such items   2 people   [Open >]|
+--------------------------------------------------------------------+
| Last scanned 10:42   [Scan again]                                   |
+--------------------------------------------------------------------+
```
Copy: sort by "most urgent first" using due dates and open state. Counts in plain words. No percent column.

## 2. Area

```
Coverage / Payments service
+--------------------------------------------------------------------+
| Payments service                                                    |
| 7 items rely on one person. 31 are covered by two or more.          |
+--------------------------------------------------------------------+
| Item                          Who knows it          Due     Status  |
| PAY-412 Refund webhook fails  Priya (9 of 11 replies) Fri   Open    |
| PAY-398 Ledger rounding       Priya (5 of 6 replies)  --    Open    |
| Runbook: Chargebacks (page)   Sam (all 6 edits)       --    Page    |
+--------------------------------------------------------------------+
```

## 3. Item

```
Coverage / Payments service / PAY-412
+--------------------------------------------------------------------+
| PAY-412  Refund webhook fails for EU cards                          |
| Only Priya has answered here (9 of 11 replies).  [Why?]             |
| Out from Mon 17 Nov to 28 Dec (entered by you)                      |
+--------------------------------------------------------------------+
| Who could cover                                                     |
| (o) Dana   Reviewed the last 3 PRs in this service       [Pick]     |
| ( ) Ravi   On the same team, light workload this month              |
+--------------------------------------------------------------------+
| [Add to Priya's plan]                                               |
+--------------------------------------------------------------------+
Why drawer (right side): list of signals with counts, last activity,
"found only through Teamwork Graph: PR reviews, team". Number detail here only.
```

## 4. Person plan

```
Plans / Priya  |  Out Mon 17 Nov - Sun 28 Dec        [Change dates]
+--------------------------------------------------------------------+
| 12 items need cover. 9 have a suggested person.                     |
| Item                  Cover with      Why                  Action   |
| PAY-412               Dana  [v]       Reviewed 3 PRs       Reassign |
| PAY-398               Ravi  [v]       Same team            Watcher  |
| Runbook: Chargebacks  -- choose --    No clear fit         Page     |
+--------------------------------------------------------------------+
| Handover page for each person: [x] Create in space [Team space v]   |
| [Preview changes]                                                   |
+--------------------------------------------------------------------+
Step 2 Preview: list of exact changes, "Nothing changes until you apply."  [Apply 9 changes]
Step 3 Progress: bar, per-item result (Done / Skipped: no permission / Failed: reason + Retry)
Step 4 Re-scan: "Before: N items with nobody covering. After: M."  (numbers TBD-from-eval in demo)
Activity tab: each run, who ran it, [Undo this run]
```

## 5. Jira issue panel (compact, 300-400px)

```
+-------------------------------+
| Coverage                      |
| Only Priya has answered here. |
| She's out from Mon 17 Nov.    |
| Dana could cover.             |
| [Plan cover]  [Why?]          |
+-------------------------------+
```
When covered: "Two or more people have answered here." (quiet, no warning).

## 6. Rovo agent reply

```
You: What breaks if Priya is out for six weeks?
Agent: 12 items rely mainly on Priya. 3 are due before she's back.
  - PAY-412 Refund webhook fails (due Fri). Dana reviewed related PRs.
  - PAY-398 Ledger rounding. Ravi is on the same team.
  - Runbook: Chargebacks. No clear person.
  [Open plan]  [Show all 12]
Want me to put this plan together for you to review? I won't change anything until you confirm.
```
Rules: plain sentences, at most 3 listed items, link out for the rest, never claim an action ran unless it did.

## 7. Setup / self-check panel

```
Setup check                                  Last checked 10:40 [Check again]
+--------------------------------------------------------------------+
| (check) Jira read access                        OK                  |
| (check) Teamwork Graph                          OK                  |
| (warn)  Teamwork Graph: PR data                 Missing permission. [How to fix]|
| (check) Rovo agent                              Available           |
| (info)  Connecting other tools (MCP)            Off. An admin turns this on. [Steps]|
+--------------------------------------------------------------------+
```
Every non-OK row has a fix link. Never show an empty list without saying why.

## 8. Sample-org banner
Persistent, top of every page in sample mode. Info appearance (blue).
"You're looking at example data. Plans can be previewed here, but nothing in your site changes. [Switch to my site]"
Apply button reads "Apply (sample only)" and writes nothing to the real site.

## 9. States (apply to every screen)

| State | Layout | Copy |
|---|---|---|
| Empty (no scan yet) | Empty state, one primary button | "No scan yet. Scan a project or space to see where work depends on one person. [Scan] or [Try example data]" |
| Empty (nothing at risk) | Positive, quiet | "Nothing here relies on one person right now." |
| Loading (scan) | Progress bar + skeletons | "Scanning PAY: 240 of 1,200 items. You can leave this page; it keeps going." (numbers are runtime values, not metrics) |
| Partial | Banner, warning | "Some results are missing because Teamwork Graph isn't available. [Setup check]" |
| Error | Section message with retry | "Couldn't load this. Nothing was changed. [Try again] Details" |
| Permission denied (viewer) | Item row kept, locked | "You can't see this item. It's counted but not shown." |
| Permission denied (write) | Per-item result | "Skipped: you don't have edit access to PAY-398. Ask a project admin or choose someone else." |
| Not an admin | Setup page read-only | "An admin needs to enable this. Here's what to send them. [Copy message]" |

## Atlassian Design System mapping

| Need | Use |
|---|---|
| Layout, spacing | Primitives (Box, Stack, Inline, Flex), spacing tokens `space.*` |
| Colors, text | Design tokens only: `color.text`, `color.text.subtle`, `color.background.neutral`, `color.background.warning`, `color.border`; no hex |
| Tables | Dynamic table; Tree table not needed |
| Banners and messages | Banner / Section message with appearance info, warning, error, success |
| Status chips | Lozenge (Open, Page, Skipped); avoid color-only meaning |
| Actions | Button (primary one per view), Dropdown menu |
| Pickers | Select / User picker for cover person, Date picker for leave dates |
| Why drawer | Drawer or Popup; tooltip for short numeric detail |
| Progress | Progress bar, Spinner, Skeleton |
| Empty states | Empty state pattern |
| Navigation | Tabs, Breadcrumbs |
| Feedback | Flag for apply result |
| Issue panel | Forge UI Kit or Custom UI sized for the panel, same tokens |

Accessibility: real headings, focus order, status always has text, contrast checked in light and dark themes, tested at 400px panel width.
