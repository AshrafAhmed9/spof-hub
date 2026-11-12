---
name: depth-chart
description: Find Jira work that depends on one person, see what is exposed while someone is away, and get suggested cover. Use when a user asks where their team depends on one person, what breaks if someone is out, who should take over a Jira item, or for a handover brief. Read-only.
---

# Depth Chart tools

Depth Chart reads Jira activity (comments, assignments, authorship) and reports where one person holds most of the work. It is exposed through the Rovo MCP server as four read-only tools. Nothing here changes Jira. Changes are made in the Depth Chart app after a person approves them.

The tools only return what the signed-in user is allowed to see in Jira.

## Tools

find-single-points. Use for "where do we depend on one person?". Inputs: `area` (optional text, a component or project name or part of it, empty for everything), `limit` (optional number, up to 30, default 12).

at-risk-for-person. Use for "what breaks if Dana is out?". Returns open work that would be exposed, ranked, with reasons and a suggested successor for each. Inputs: `person` (required, name as shown in Jira), `from` (optional, YYYY-MM-DD, default today), `to` (optional, YYYY-MM-DD, default 14 days after the start).

suggest-successor. Use for "who should take over ABC-123?". Returns up to three people with the evidence for each. Inputs: `itemKey` (required, for example ABC-123), `excludePerson` (optional, someone who must not be suggested, usually the one leaving).

handover-brief. Use for "write a handover brief for Dana". Returns the plan for a person grouped by area, with reasons and suggested successors, so you can write the brief. Inputs: `person` (required), `from` and `to` as above.

## Reading results

Results can carry `notes` (a list of plain-text caveats, for example that a missing end date was assumed to mean 14 days) and a `complete` flag. Repeat the notes to the user. If `complete` is false, say the result may be missing items, for example because some Teamwork Graph records belong to another viewer. Don't present an incomplete result as the full picture.

If a name isn't found, the tool returns an `error` message. Ask the user for the name as it appears in Jira.

## Setup

An admin turns on "Expose tools to MCP-compatible apps" for the app under Site settings, Connected apps. The client then connects to `https://mcp.atlassian.com/forge/<app id>` and signs in.
