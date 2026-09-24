# MCP token usage after bounded results (beta.78)

Research date: 2026-09-25. Measured on production (`clanker-002`, mikan `1.0.0-beta.78`) through the livingbio Pi DM, with OpenConnector reached at `http://127.0.0.1:3100/mcp`. Sizes are tool-result characters in the session file; costs come from the session's recorded usage.

## Baseline

Bounding MCP results (`2fd33fdd`) removed the largest single results. `list_apps` without a query fell from 388,364 characters to an 808-character digest, and `googleslides.create_presentation` from 312,155 to 3,401. A comparable Slides turn went from a context jump of 48k to 102k tokens to steady growth from 29k to 39k.

| Test                                      | Where           | LLM calls | Cost  | Largest results                                                        | Outcome                         |
| ----------------------------------------- | --------------- | --------- | ----- | ---------------------------------------------------------------------- | ------------------------------- |
| `search_actions` with and without service | DM              | 3         | $0.10 | 21,955 (`service=googledrive`, 13 hits); 2,824 digest (no service, 50) | Answered                        |
| Metabase databases                        | background task | 4         | $0.26 | `list_databases` 37,676; `search_actions` 12,008                       | Answered                        |
| Sentry organizations and issues           | background task | 5         | $0.35 | `search_actions` four times, 22,231–31,861 each                        | Gave up                         |
| Finance apps from `list_apps`             | DM              | 4         | $0.16 | `list_apps(query="Finance")` 19,723                                    | Answered after the spill failed |
| GitHub without a connection               | DM              | 3         | $0.10 | `search_actions` 9,767                                                 | Reported the missing connection |

## Findings

### 1. Spilled results cannot be read with `read`

The full result was spilled as compact JSON, which is a single line. `read` refuses a first line over its limit: `[Line 1 is 249.2KB, exceeds 50.0KB limit. Use bash: sed -n '1p' … | head -c 51200]`, and `grep` returns the whole line. The notice promises "read with offset/limit or grep", which neither can deliver. The agent recovered only by re-querying with a filter.

### 2. `search_actions` dominates the remaining cost

Each call returns 10–30k characters (about 3–8k tokens), and a turn typically makes two to four. The `service` filter narrows results substantially, but the agent rarely supplies it. In the Sentry test the agent searched four times without a service, then abandoned the task, because Sentry actions take `organizationIdOrSlug` directly and no "list organizations" action exists.

### 3. Background tasks start with a cold prompt cache

The agent moved the Metabase and Sentry tests into `start_task`. Each task session begins with an uncached prompt of about 28k tokens (about $0.14 at the configured model's input price), so the same work costs more than in the conversation's own session.

## Status

- Finding 1: fixed by spilling indented JSON.
- Finding 2: open.
- Finding 3: open.
