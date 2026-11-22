# How pure the platform interface is (2026-11)

Question from the owner: messages reach mikan from Slack, Telegram, Discord, and GitHub; how coupled is that, and is the interface pure and flexible enough?

## What holds

- Core modules cannot import `src/adapters/`; a source guard enforces it, and only the composition root (`main.ts`, `cli/`, `runtime/`) wires adapters in.
- The contract is in one place, `src/types.ts`: `ConversationEvent`, `ConversationContext`, `ConversationResponder`, `MessagingBot`, `MessagingEventHandler`, and `MessagingInfo`.
- Output is platform-neutral: the harness writes Markdown, and each adapter renders it.
- Vault policy reads `MessagingInfo.trustModel`, a value, not a platform name.

## Where the core asked which platform it was on

| Place                                             | What it did                                                                                 | State after this change                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `harness/prompt.ts`                               | Added a "Slack Rendering" section when `platform.name === "slack"`                          | The Slack adapter's `formattingGuide` carries it; the prompt text is byte-identical     |
| `harness/prompt.ts`                               | Listed attachments in `<slack_attachments>` on every platform                               | `<attachments>`                                                                         |
| `sessions/session-key.ts` `inferConversationKind` | Told direct from shared conversations by each platform's ID shape                           | `MessagingBot.conversationKindOf`, answered by each adapter                             |
| `harness/open-connector.ts`                       | Built the token name for `slack` (with a workspace ID) and `github`, nothing for the others | `MessagingInfo.connectorScope`, given by the adapter; the core appends the conversation |
| `harness/tools/react.ts`                          | Named Slack, Discord, and Telegram in the tool's description                                | Says what forms an emoji can take                                                       |
| `office/projection.ts` `PUBLIC_CAPABLE_PLATFORMS` | Only a Slack office can be public                                                           | Unchanged, see below                                                                    |
| `PlatformName`, the office-key pattern, `migrate` | A closed list of four platforms, written in three places                                    | Unchanged, see below                                                                    |
| `ConversationEvent.thread_ts`, `ts`; log fields   | Slack's names for a thread and a message; `slackBlocks` and `slackInteraction` in the log   | Unchanged, see below                                                                    |
| `MessagingBot`'s optional methods                 | `postInThread`, `postPrivate`, `postPrivateDiagnostic`, `logBotResponse`                    | Unchanged, see below                                                                    |

Removed earlier in the same refactor: the responder's task functions and the steer port, which only Slack implemented (ADR 0032), and Slack's own way into a session for a background job's notice, replaced by one rule for every adapter (ADR 0033).

## Left as it is, and why

- **Which offices can be public.** Only the Slack adapter records a channel's kind, so the platform check in `resolveOfficeVisibility` decides nothing that the missing record would not. It changes one thing: Admin tells an operator that a Telegram, Discord, or GitHub office is private because of its platform, not because its kind is unknown, and a test states that on purpose. Moving the fact to the adapters means three of them recording a kind they never use.
- **The closed list of platforms.** Opening it is a design of its own: the office key embeds the platform name and is the name of a directory and of a container, and migrations enumerate the platforms. No fifth platform is planned.
- **Slack's field names.** `thread_ts`, `ts`, `slackBlocks`, and `slackInteraction` are in `log.jsonl`, which the agent reads with `grep` and which every existing office holds. Renaming them is a migration of every office's log for no behavior anyone would see.
- **Optional methods on `MessagingBot`.** Each is a real difference between platforms: Telegram has no thread to post in, GitHub has no private message. Callers check for them in a handful of places. Making them required would move the same branches into the adapters as stubs.
- **Adapters that open sessions and offices themselves.** The Slack adapter still reaches into `sessions/` for thread registration and continuation. Task threads were most of that and are gone; the rest is the next thing to look at when one of those paths changes.

## Acceptance eval

`.workspace/adapter-interface-eval/prompt.eval.ts` builds each adapter with stand-in clients and compares the system prompt and the attachment listing.

| Case                                     | Baseline (57897023)                             | Expected        | After             |
| ---------------------------------------- | ----------------------------------------------- | --------------- | ----------------- |
| Slack system prompt                      | 9,642 chars, `8a7f71ffba8f`                     | Identical       | Identical         |
| Telegram system prompt                   | 9,184 chars, `fe3994795378`                     | Identical       | Identical         |
| Discord system prompt                    | 9,342 chars, `79d5bab933b8`                     | Identical       | Identical         |
| Attachment listing                       | `<slack_attachments>`                           | `<attachments>` | `<attachments>`   |
| Who tells direct from shared             | The core, by platform name                      | The adapter     | The adapter       |
| OpenConnector token name, Slack / GitHub | `mikan:slack:<team>:<id>` / `mikan:github:<id>` | Same            | Same (unit tests) |
