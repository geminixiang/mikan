# Pi package features mikan does not use yet (2026-10)

Question: which features of the installed Pi packages (`pi-durable`, `pi-ai`, `pi-mcp`, `pi-codemode`, `chord`, all 1.1.0) could replace mikan code or give mikan users something new?

Sources: each package's README, CHANGELOG, and type declarations in `node_modules/@earendil-works/`, the pi-durable examples at the 1.1.0 release commit, Pi's coding agent as installed, and mikan's imports (`src/`, tests excluded). Experiments are under `.workspace/pi-features/`, on a `sqlite3 .backup` copy of a local test DM office.

## How much mikan already uses

Counted by exported names of each package root that appear in mikan's production code. Subpath entries (`pi-durable/tools`, `pi-ai/providers/all`, `pi-ai/utils/*`) are used too and not counted.

| Package       | Root exports used | Main uses                                                                                                 |
| ------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `pi-durable`  | 52 of 192         | Harness, conversations, forks, documents, tasks, tool registrations with `replay`, events                 |
| `pi-codemode` | 10 of 35          | Sandbox, source parsing, declarations                                                                     |
| `pi-mcp`      | 10 of 66          | Client and both transports                                                                                |
| `chord`       | 2 of 72           | `Context` and JSON types; services and replicated state target a client/server design mikan does not have |

Many unused names are types; the candidates below are the features behind them.

## Candidates

### 1. Admin usage from pi-durable's usage ledger

`serveSessionUsage` in `src/adapters/web/admin/portal.ts` sums `usage` over every assistant entry that `SessionStore.inspect` returns for each session. pi-durable keeps each conversation's own spend in `pi.usage` (`UsageDoc`): model responses and compaction attempts by `provider/model`, and tool usage by tool name, including failed and aborted attempts.

Measured on the local copy, 26 sessions:

| Session                                    | Tokens summed from entries | Tokens in `pi.usage` |
| ------------------------------------------ | -------------------------- | -------------------- |
| 25 sessions                                | equal                      | equal                |
| One thread started from its cause (a fork) | 3,106,025                  | 44,982               |
| Time for all 26                            | 18.1 ms                    | 0.7 ms               |

`Conversation.entries()` includes the history a fork inherits from its parent, so the Admin portal counts the parent's spend again in every thread forked from it ([threads that start from their cause](thread-session-origin-2026-10.md)). `pi.usage` counts each conversation's own spend once.

Second pass: `pi.usage` is written by generation only. An assistant entry appended directly, which is how `mikan migrate` imports sessions from before pi-durable, records nothing there; appending one with usage to an in-memory harness left `pi.usage` empty. Reading `pi.usage` alone would therefore drop the spend of imported history. Each `EntryRecord` carries the `conversationId` that wrote it, so summing only a session's own entries also removes the double count while keeping imported spend, but it still misses failed attempts and compaction spend, which only `pi.usage` records.

### 2. MCP tool results through `toLlmContent`

`mcpResultContent` in `src/harness/mcp-result.ts` converts MCP content blocks to model content; `pi-mcp` exports `toLlmContent` for the same job. Compared on ten result shapes:

| Shape                                                | mikan                                | `toLlmContent`                                                           |
| ---------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| Text, image                                          | same                                 | same                                                                     |
| Embedded image resource                              | Text placeholder, image dropped      | The image                                                                |
| Embedded text resource                               | Text with a `[Resource: uri]` header | The text                                                                 |
| Binary resource, audio, resource link, unknown block | Placeholders in mikan's wording      | Placeholders in pi-mcp's wording; an unknown block is not dumped as JSON |
| Structured content only                              | Compact JSON                         | Indented JSON                                                            |
| No content                                           | `(empty result)`                     | Empty list                                                               |

Adopting it removes mikan's block conversion and passes embedded images to the model. The empty case still needs mikan's placeholder, because a provider can reject a tool result with no content. The truncation, digest, and spill code in the same file are unaffected.

### 3. Codemode `store` that lasts across calls

`pi-codemode` reports what a script stored as `result.storeWrites` and takes the current values as `options.store`; the sandbox persists nothing itself. Pi's coding agent replays `codemode-store` entries from the branch so values last across calls. mikan's codemode tool tells the model the opposite: "store/load values last only for this script, not across calls." Keeping the writes as session entries would match Pi.

### 4. Model subscription login

`pi-ai` providers carry OAuth login for Anthropic (Claude Pro and Max), OpenAI (Sign in with ChatGPT), GitHub Copilot, and OpenRouter. `Models.login()` runs the flow and stores the credential in a `CredentialStore`, and requests refresh it under the store's lock. pi-ai ships only an in-memory store; Pi's coding agent keeps credentials in `auth.json`. mikan resolves provider keys from the environment only. A file store in Pi's `auth.json` format plus a `mikan login <provider>` command would let an outside user run mikan on a subscription without an API key. Whether each subscription's terms allow a shared bot has not been checked.

### 5. OAuth for remote MCP servers

`pi-mcp/oauth` implements discovery, dynamic client registration, PKCE, refresh, and step-up, with a pluggable state store; Pi's coding agent keeps those tokens in `mcp-auth.json`. mikan supports remote MCP servers with static headers and vault credentials only. The [MCP marketplace research](mcp-marketplace-2026-09.md) chose to build no OAuth until a concrete server needs it; pi-mcp now supplies the protocol, so the remaining work is the callback route on mikan's web server and token storage.

### 6. Manual compaction and reset with a handoff

pi-durable offers `conversation.compact(instructions)` and `conversation.reset(handoff)`. Pi's coding agent exposes `/compact`. mikan compacts only automatically, and `/new` resets with nothing carried over.

## Outcome

| Candidate                           | Shipped in                                                                                                       | Acceptance eval                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1. Usage ledger                     | [#162](https://github.com/geminixiang/mikan/pull/162), with migration `0013-session-usage` for imported sessions | Forked thread 33,344 → 16,704 tokens (its own spend); imported session kept at 1,500; daily chart 58,351 → 41,711  |
| 2. `toLlmContent`                   | [#161](https://github.com/geminixiang/mikan/pull/161)                                                            | Embedded image resource reaches the model as an image; empty result keeps its placeholder                          |
| 3. Codemode store                   | [#163](https://github.com/geminixiang/mikan/pull/163)                                                            | Values last across scripts, messages, and a restart; a thread started from a run inherits them; `/new` clears them |
| 6. Manual compaction                | [#164](https://github.com/geminixiang/mikan/pull/164), as `/compact` in DMs and channels                         | A long session went from 12 to 5 context messages with one model call; a short one reports nothing to compact      |
| 4. Subscription login, 5. MCP OAuth | Not started                                                                                                      |                                                                                                                    |

## Not now

| Feature                                                     | Reason                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pi-ai` image generation (`generateImages`)                 | Only OpenRouter implements it; mikan's `generate_image` posts to any OpenAI-compatible `/images/generations` endpoint, which a private gateway relies on           |
| `pi-telemetry` spans                                        | The trigger in the [telemetry research](pi-telemetry-adoption-2026-09.md) has not fired: pi-ai 1.1.0 only forwards a `telemetryContext` option and starts no spans |
| `taskGraph()` for an Admin task panel                       | mikan's task anchors are terminal at once, and the graph lists live tasks only                                                                                     |
| `durationMs` on tool results and answers (pi-durable 1.1.0) | The presenter already times tools; worth using only when it is next changed                                                                                        |
| Chord services and replicated state                         | They serve remote clients of a session; Session View reads run events in-process                                                                                   |
