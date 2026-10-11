---
status: accepted
---

# Read the web through a built-in host tool

mikan offers `web_fetch`, a built-in tool that reads a public web page or API on the host and returns its text in bounded windows. A model without it answers current-fact questions from memory or a stale search snippet.

## Context

Ten questions about current facts (package, language, and release versions, today's weather, this week's news), asked through mikan with the same model and graded against the official sources:

| Setup                                          | Correct | Confidently wrong | Mean seconds |
| ---------------------------------------------- | ------- | ----------------- | ------------ |
| No web tool (only `jev_browser` and `bash`)    | 2       | 1                 | 33           |
| Brave Search MCP                               | 7       | 2                 | 25           |
| Brave Search MCP and a reader (3 rounds, mean) | 8.0     | 0.7               | 19           |
| `web_fetch` prototype as an MCP server         | 10      | 0                 | 15           |
| Built-in `web_fetch`                           | 10      | 0                 | 11           |

Search snippets alone produced confident wrong versions, because the snippet was older than the page. The answers became right once the model could read the official page, registry, or API. `jev_browser` timed out or failed on most of those pages. Without a search key the model still found this week's news by reading a news feed.

Pi offers web tools only as coding-agent extensions (for example `pi-web-access`, `pi-web-search`, and `rpiv-web-tools`). They register through the coding agent's `ExtensionAPI` and import `pi-coding-agent` and `pi-tui` at runtime; pi-durable has no loader for them, and Pi's own durable frontend lists extensions as unsupported.

## Decision

- `web_fetch` is a mikan tool, offered in every conversation and needing no key. It follows the shape of `rpiv-web-tools`' `web_fetch`. HTML becomes text with links kept; JSON and plain text are returned raw. Long content comes in 12,000-character windows that `offset` or `find` move.
- It refuses non-HTTP URLs and private, loopback, and link-local addresses, checking every resolved address before the request and again when connecting, on every redirect hop.
- Web search is not part of this decision.

## Consequences

- Each request carries about 1,200 more characters of tool description and system prompt.
- The host makes requests the model chooses. The address checks keep them off the host's own network, but the host's public IP is visible to the sites it reads.
- A deployment that reaches the web only through an HTTP proxy cannot use `web_fetch`.
- When pi-durable can load Pi extensions, a community extension can replace this tool.
