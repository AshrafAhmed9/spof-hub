# Depth Chart privacy policy

Last updated: 10 November 2026

Depth Chart is an Atlassian Forge app. It runs on Atlassian's infrastructure and does not send your data anywhere else.

## What it reads

When someone on your site runs a scan, the app reads Jira and Confluence as the app itself. Reads from Teamwork Graph use the permissions of the person who is viewing:

- Jira work items: key, summary, status, priority, due date, component, assignee, links, comments, status changes, and who made them.
- Confluence pages: title, space, and who wrote each version.
- Atlassian Teamwork Graph, where that person has access: team membership, goals, and pull requests linked to work items.

## What it keeps

The app stores a scan index in Forge storage for your site. It holds Atlassian account IDs and display names, counts of who contributed to each item, the plans you create, and an audit log of changes the app made. It stores work item summaries and page titles so results are readable. It does not store comment text, issue descriptions, or page bodies.

Each product keeps its own copy. A Jira install and a Confluence install do not share an index.

## Where it goes

Nowhere. The app makes no outside network calls and has no connection to an AI service. Everything is computed inside Forge. The only outside party involved is Atlassian, which hosts Forge.

## Who sees it

Because the scan covers the whole site, the app checks each viewer's own permissions when showing results. Items a person cannot open in Jira or Confluence are left out of what they see.

The app does not rank people, and it does not report on individuals' performance. It shows which work depends on one person, so it can be covered.

## Changes the app makes

The app changes your site only after someone approves a plan: reassigning a work item, adding a comment, or adding a watcher. Each change is logged and can be undone from the app.

## Personal data reporting

Once a week the app reports the account IDs it holds to Atlassian's personal data reporting API. If an account has been closed, the app deletes the records that mention it. If a profile changed, the app refreshes the stored name.

## Removing your data

Uninstalling the app stops all access. Contact us (see the support page) and we will confirm what remains for your site.

## Contact

Questions or deletion requests: open an issue at https://github.com/AshrafAhmed9/spof-hub/issues, or use the contact details on the Marketplace listing.
