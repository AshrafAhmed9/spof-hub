# Depth Chart

A Forge app for Jira that finds work only one person understands, and helps you cover it before they are away.

Handover tools I found move assignees after someone has already left. This one starts earlier. It reads who actually answered questions and commented in each area (and, where Teamwork Graph has them, reviewed), and shows where one person holds most of it. It then suggests who could cover each item, lets you approve the changes, applies them, and re-scans to show what's left. Every change can be undone.

## What's in here

| Folder | What it is |
|---|---|
| `engine/` | The scoring logic in plain TypeScript, with no Forge imports. Contribution share, truck factor per area, risk spreading along links, successor matching. Vitest and fast-check tests. |
| `app/` | The Forge app: resolvers, scan, apply and undo, Rovo agent and actions, MCP tools, and the Custom UI in `app/static/hub`. |
| `backtest/` | A check of the scoring on public Apache Jira projects, with the definitions written before the run. |
| `docs/` | Wireframes. |

## How it works

- Scan. Reads Jira issues, comments and status changes, and Teamwork Graph where the viewer has access. Everything stays in Forge storage. The app has no LLM and makes no outside network calls.
- Score. Each item gets the share of the work held by its top person. Each area gets a truck factor. Risk is passed along blocking links.
- Plan. For a person and a date range, the app lists the items that need cover and suggests a successor for each, with the reason.
- Apply. Reassigns, comments and watches go through idempotent steps with an audit record, so a retry never repeats a change.
- Example company. A fresh install can open a pseudonymized sample so the whole flow can be tried without touching the site.

## What the backtest shows, and doesn't

Among 1,416 high-concentration pairs on five Apache projects (items where someone who later left held at least half the comment weight), 93% were not assigned to that person today. Assignee is the current one, fetched after people left, so some items were reassigned later. The number shows how much of this work the assignee field doesn't reflect now, not what it showed the day they left. Per project it ranges from 3% to 41% assigned to the leaver. A predictive test pointed the right way (concentration difference +0.092, CI +0.028 to +0.134), but a plain comment-count share did slightly better (+0.120), so the app makes no predictive claim. Details, caveats and the protocol are in `backtest/RESULTS.md` and `backtest/DEFINITIONS.md`.

A second check asked whether the suggested successor is the person who actually picked the work up after a contributor left. Over 518 item-person pairs from the same projects, the suggestion was in the top three 42% of the time, against 2% for a random pick and 41% for "whoever commented most on that item". So the suggestions come from the item's real history and are far better than chance, but this data doesn't show them beating that simple rule. See `backtest/RESULTS_SUCCESSOR.md`.

The example company is derived from public issue metadata of Apache Kafka (issues.apache.org, project KAFKA), with people replaced by fictional names and comment text removed. Apache Kafka is a trademark of the Apache Software Foundation; this project is not endorsed by the ASF.

## Installing

Install on Jira Cloud with [this link](https://developer.atlassian.com/console/install/0bdff584-47d8-4553-9367-624e76aac29b?signature=AYABeFZ2zNuDic47rYiIrVJuE%2BgAAAADAAdhd3Mta21zAEthcm46YXdzOmttczp1cy13ZXN0LTI6NzA5NTg3ODM1MjQzOmtleS83MDVlZDY3MC1mNTdjLTQxYjUtOWY5Yi1lM2YyZGNjMTQ2ZTcAuAECAQB4CxqLTo9l4lqXuFjNim1xJM%2Bp%2F3TVP9xHS2BrU5DRRucBru9W%2FsvCFla0v9ZrPKb7igAAAH4wfAYJKoZIhvcNAQcGoG8wbQIBADBoBgkqhkiG9w0BBwEwHgYJYIZIAWUDBAEuMBEEDHK17Wchm4PXhB2I5QIBEIA7IDjBY2lGW8naEXvLUowda4DwhNwSUP6%2Fm4Qe0bdtj2RrqwGaPVxLv1DoRLzUw%2Fe8HQyDSMU6hnp1xQ8AB2F3cy1rbXMAS2Fybjphd3M6a21zOmV1LXdlc3QtMTo3MDk1ODc4MzUyNDM6a2V5LzQ2MzBjZTZiLTAwYzMtNGRlMi04NzdiLTYyN2UyMDYwZTVjYwC4AQICAHi9bVMAkme4qVQX1fQHo6ePw3H40A7cGfz7yrmSfBWMXgFxX%2BB8of7Az8nRLnhy%2BSB2AAAAfjB8BgkqhkiG9w0BBwagbzBtAgEAMGgGCSqGSIb3DQEHATAeBglghkgBZQMEAS4wEQQMy%2F6UkZ%2FpjD27VvgHAgEQgDvdbXAt6i3oeVKTW4q5bDVVxdmlB%2FbNpjpN0FJ1hWkwokqH3WflBEL2uwgYIglPs0d4G00EwoS8npxagwAHYXdzLWttcwBLYXJuOmF3czprbXM6dXMtZWFzdC0xOjcwOTU4NzgzNTI0MzprZXkvNmMxMjBiYTAtNGNkNS00OTg1LWI4MmUtNDBhMDQ5NTJjYzU3ALgBAgIAeDYASx0XCjkny4iLV6vz%2BKtEGSGT6kdt0QRpkn6D%2FlVEAYXgrX3qkC3wQ6V53Ert3I8AAAB%2BMHwGCSqGSIb3DQEHBqBvMG0CAQAwaAYJKoZIhvcNAQcBMB4GCWCGSAFlAwQBLjARBAx4LdE1Az18ZKFgZ%2FoCARCAO6d25jfHNa%2FhRnuvqrM%2F66mp%2F6IlEQ%2FVMsVvZe%2FIoeLZW7vbUzNbYHfXkLnRgxxYLn57iviFrSKqZw%2FeAgAAAAAMAAAQAAAAAAAAAAAAAAAAAP3roJgTbITaOkbdmtqbVzL%2F%2F%2F%2F%2FAAAAAQAAAAAAAAAAAAAAAQAAADJiKbxsccnN2vHkhcoN%2BNy%2BZFXsSMCWqTGPtDHPQHtrwPyor2QtA3yR0L3C2X4qaQFWV2%2Bf3mp4Pb4ZGg0Eba5wp6Q%3D&product=jira). It installs a copy of the Marketplace app with the same code, because Atlassian turns off install links once an app is listed.

The app runs in Jira. Open Depth Chart from the Apps menu and run a scan. On a large site, the scan box accepts project keys (for example `MOB, CX`) so you can start with a few projects. The Rovo agent and the MCP tools read the same index.

Confluence is not supported. A Forge app that requires both products can only be listed on the Marketplace as a paid app, and this one is free.

## Using the MCP tools

An admin turns on "Expose tools to MCP-compatible apps" for the app under Site settings, Connected apps. A client then connects to `https://mcp.atlassian.com/forge/<app id>` and signs in. It gets four read-only tools: `find-single-points`, `at-risk-for-person`, `suggest-successor` and `handover-brief`.

An agent skill file for third-party agents is in [docs/mcp-skill.md](docs/mcp-skill.md).

## Known limits

- Teamwork Graph is in preview and its reads run as the viewing user, so they only advance while the page is open.
- Scans are slow on large sites and need the page open. Each page load reads the whole index from Forge storage, which counts against the free monthly allowance.
- An item counts as depending on one person only when it has at least three recorded contributions and one person holds 80% or more of them.
- Some issue types cannot be assigned (Jira Product Discovery ideas). Those changes are refused by Jira and reported as not applied.
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
