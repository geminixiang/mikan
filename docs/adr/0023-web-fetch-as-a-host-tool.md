---
status: accepted
---

# Read the web through a built-in host tool

mikan offers `web_fetch`, a built-in tool that reads a public web page or API on the host and returns its text. A model without it answers current-fact questions from memory or a stale search snippet.

## Context

Ten questions about current facts (package, language, and release versions, today's weather, this week's news), asked through mikan with the same model and graded against the official sources:

| Setup                                          | Correct | Confidently wrong | Mean seconds |
| ---------------------------------------------- | ------- | ----------------- | ------------ |
| No web tool (only `jev_browser` and `bash`)    | 2       | 1                 | 33           |
| Brave Search MCP                               | 7       | 2                 | 25           |
| Brave Search MCP and a reader (3 rounds, mean) | 8.0     | 0.7               | 19           |
| `web_fetch` prototype as an MCP server         | 10      | 0                 | 15           |
| Built-in `web_fetch`                           | 10      | 0                 | 7            |

Search snippets alone produced confident wrong versions, because the snippet was older than the page. The answers became right once the model could read the official page, registry, or API. `jev_browser` timed out or failed on most of those pages. Without a search key the model still found this week's news by reading a news feed.

Pi offers web tools only as coding-agent extensions (for example `pi-web-access`, `pi-web-search`, and `rpiv-web-tools`). They register through the coding agent's `ExtensionAPI` and import `pi-coding-agent` and `pi-tui` at runtime; pi-durable has no loader for them, and Pi's own durable frontend lists extensions as unsupported.

## Decision

- `web_fetch` is a mikan tool, offered in every conversation and needing no key. HTML becomes Markdown through `@mdream/js` with its minimal preset, which drops navigation and other page chrome; JSON and plain text are returned as they are. The result is bounded and spilled to the workspace like an MCP result.
- It refuses non-HTTP URLs, and its connections refuse private, loopback, and link-local remote addresses, so redirects and DNS answers are covered by the same check.
- Web search is not part of this decision.

`@mdream/js` was compared on seven real pages (release pages, GitHub, a weather service, Wikipedia) with `html-to-text`, `turndown`, `node-html-markdown`, and Readability with Turndown. It kept the answer on every page, produced the smallest output, and installs in 0.6 MB with two dependencies. Readability dropped the version table on one page, and `node-html-markdown` took 29 seconds on a 3 MB page.

## Consequences

- Each request carries the tool description and one system prompt line.
- The host makes requests the model chooses. The address checks keep them off the host's own network, but the host's public IP is visible to the sites it reads.
- A deployment that reaches the web only through an HTTP proxy cannot use `web_fetch`.
- When pi-durable can load Pi extensions, a community extension can replace this tool.
