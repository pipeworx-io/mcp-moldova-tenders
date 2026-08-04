# mcp-moldova-tenders

Moldova Government Procurement (MTender) MCP — keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `moldova_recent_tenders` | Most recent government procurement tenders from Moldova's national e-procurement platform (MTender), published as Open Contracting (OCDS) data. Returns each tender with ocid, title, buyer (procuring entity), value + currency (MDL), status, CPV classification, and publication/period dates. Titles and descriptions are in Romanian. Use moldova_get_tender for the full detail of one tender. |
| `moldova_get_tender` | Full detail for a single Moldova (MTender) government procurement tender by its OCDS contracting id (ocid, e.g. "ocds-b3wdp1-MD-1539840280133"). Returns title, description, buyer/procuring entity, value + currency, status, procurement method and category, CPV classification, tender period dates, budget, and parties. Get an ocid from moldova_recent_tenders or moldova_search_tenders. |
| `moldova_search_tenders` | Keyword search over recent Moldova (MTender) government procurement tenders. Scans the most recent tenders and returns those whose title, buyer, or CPV description contains the query (case-insensitive; Romanian text). Note: this is a client-side filter over recent tenders (MTender has no native full-text search), so it matches recent listings only. Returns shaped tenders like moldova_recent_tenders. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "moldova-tenders": {
      "url": "https://gateway.pipeworx.io/moldova-tenders/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Moldova Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
