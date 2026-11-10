# Depth Chart

A Forge app for Jira and Confluence that finds work only one person understands, and helps you cover it before they are away.

Most handover tools move assignees after someone has already left. This one starts earlier. It reads who actually answered questions, commented, reviewed and wrote the pages in each area, and shows where one person holds most of it. It then suggests who could cover each item, lets you approve the changes, applies them, and re-scans to show what's left. Every change can be undone.

## What's in here

| Folder | What it is |
|---|---|
| `engine/` | The scoring logic in plain TypeScript, with no Forge imports. Contribution share, truck factor per area, risk spreading along links, successor matching. Vitest and fast-check tests. |
| `app/` | The Forge app: resolvers, scan, apply and undo, Rovo agent and actions, MCP tools, and the Custom UI in `app/static/hub`. |
| `backtest/` | A check of the scoring on public Apache Jira projects, with the definitions written before the run. |
| `docs/` | Wireframes. |

## How it works

- **Scan.** Reads Jira issues and comments, Confluence page versions, and Teamwork Graph where the viewer has access. Everything stays in Forge storage. The app has no LLM and makes no outside network calls.
- **Score.** Each item gets the share of the work held by its top person. Each area gets a truck factor. Risk is passed along blocking links.
- **Plan.** For a person and a date range, the app lists the items that need cover and suggests a successor for each, with the reason.
- **Apply.** Reassigns, comments and watches go through idempotent steps with an audit record, so a retry never repeats a change.
- **Example company.** A fresh install can open a pseudonymized sample so the whole flow can be tried without touching the site.

## What the backtest shows, and doesn't

On five Apache projects that weren't used to design the method, items held mostly by someone who later left stayed unanswered for 30 days more often than other items. The direction held in four of five projects. A plain comment-count share did slightly better than the decayed score, and an assignee-only rule missed most of what was concentrated. The result supports the coverage claim (items that assignee-based tools can't see) and doesn't support a claim to predict problems. Details, caveats and the protocol are in `backtest/RESULTS.md` and `backtest/DEFINITIONS.md`.

## Known limits

- Teamwork Graph is in preview and its reads run as the viewing user, so they only advance while the page is open.
- Scans are slow on large sites (about 130 items a minute on the test site) and need the page open.
- The queue that would run scans in the background returned errors on the test site, so scans use a stored work list instead.
- The Apache data is open-source projects and current assignee only. It isn't a company.

## Run it

```
cd engine && npm install && npm test
cd ../app && npm install && npm test
cd static/hub && npm install && npm run build
cd ../.. && forge register && forge deploy && forge install
```

Needs Node 22 and the Forge CLI. `app/static/hub` also runs in a browser with `?mock` for UI work.
