# Depth Chart support

## Get help

Open an issue at https://github.com/AshrafAhmed9/spof-hub/issues. Include your product (Jira or Confluence), what you clicked, and what you expected. Please don't paste private work item contents.

## Common questions

**The page says the index is empty.**
Jira and Confluence each keep their own index. Open Depth Chart in the product you are using and run a scan there.

**A scan on a big site is slow.**
It runs about 130 items a minute and needs the page open. Enter project keys (for example `MOB, CX`) in the scan box to start with a few projects.

**A reassignment was refused.**
Some work item types cannot be assigned, such as Jira Product Discovery ideas, and some people lack permission on a project. The app reports these items as not applied.

**I can't see the "Who knows this" panel on an issue.**
New issue panels start hidden. In Jira, open Project settings, then Issue layout, and move "Who knows this" out of Hidden.

**How do I use the Rovo agent or MCP tools?**
See the README: https://github.com/AshrafAhmed9/spof-hub#using-the-mcp-tools
