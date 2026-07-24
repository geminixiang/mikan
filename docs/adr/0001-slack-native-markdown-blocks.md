# Slack prose rendering is delegated to Slack via native markdown blocks

The Slack adapter renders response-source prose as native `{type: "markdown"}` Block Kit blocks and lets Slack translate the GFM server-side, instead of owning a renderer. We deliberately do NOT construct `rich_text` blocks ourselves, and we deleted the previous mrkdwn string emission: serializing a parsed AST back into a second markup language forced escaping rules, placeholder link-protection hacks, and a formatting-guide-vs-parser contradiction that produced three production patches in one week (93705ea, 56f385a, 4cb6dfa). Native markdown blocks also use the same Slack-side renderer family as the `markdown_text` streaming API, so streamed and non-streamed renderings converge visually.

## Considered Options

- **Native markdown blocks (chosen)** — near-zero conversion code; Slack maintains the renderer; live-verified 2026-07-24: accepted by `chat.postMessage` and `chat.update`, translates to `rich_text` (including nested lists, quotes, `language`-tagged preformatted, user/channel mentions, literal `&<>`), rejects >12k chars with `msg_too_long`.
- **Own AST → `rich_text` construction** — same correctness-by-structure, but ~300–400 lines of renderer to maintain and only approximate convergence with native streaming. Revisit only if the markdown block's server-side translation proves inadequate.
- **Keep mrkdwn string emission and patch bugs** — preserves the two-grammar ambiguity that caused the churn; rejected.

## Consequences

Markdown pipe tables are not rendered by the markdown block, so they are extracted and rendered as native `table` blocks; prose over 12k characters is split at paragraph boundaries. The model is instructed to write standard GFM only (see the Response source term in CONTEXT.md); legacy `<url|label>` links are converted to `[label](url)` by a compatibility pass that can be deleted once no producer emits them.
