# Tools start in the conversation's directory (2026-11)

Issue #205: the model mistyped the office key when it read an attachment, and the Slack E2E case for two uploaded files failed about every other run.

## Cause

Tools started in the runtime workspace root, and the user message listed each attachment by its absolute path: about a hundred characters, of which the office key is forty opaque ones. Every file of the conversation had to be named through that key. `core-interfaces` already described the runtime's working directory as `<runtime workspace root>/<officeKey>`, and the prompt's own examples (`tail -30 log.jsonl`) only work from there; the execution resolver passed the workspace root instead.

## Measurement

`.workspace/attachment-paths-probe/probe.eval.ts` builds the real system prompt and user message for a channel message with two text attachments, on the model the Slack E2E uses, with `read` and `bash` stand-ins that answer only for the exact path. Thirty runs each, counting runs in which at least one call named a path that does not exist:

| Variant                                                      | Runs with a wrong path |
| ------------------------------------------------------------ | ---------------------- |
| Workspace root as working directory, absolute paths (before) | 7 of 30                |
| Conversation directory, paths relative to it (prototype)     | 1 of 30                |
| Conversation directory, paths relative to it (this change)   | 0 of 30                |

In the Slack E2E workflow the same case failed in five of seven runs on 2026-11-22, four of them from a mistyped key.

## Choices

| Choice                         | Chosen                                          | Alternative                                           | Reason                                                                                                      |
| ------------------------------ | ----------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| What the model copies          | A path relative to the conversation's directory | A hint in the failed read naming the files that exist | Less to copy for every file of the conversation, with no code that interprets a failure                     |
| Working directory              | The conversation's directory, for every tool    | A second, short mount of the office (`/office`)       | The documented contract already said so; one path per file, nothing new to translate between guest and host |
| Paths outside the conversation | Stay absolute                                   | Relative with `../`                                   | Shared memory and skills are few and short; `..` in a path is what `attach` rejects                         |
| The `<slack_attachments>` tag  | Unchanged                                       | Rename now                                            | It belongs to the adapter-interface cleanup; renaming it here would change two things at once               |

## What changes for a conversation

- `bash` starts in `/workspace/<office key>`, and a relative path in `read`, `write`, `edit`, and `attach` resolves there. Before, they started in `/workspace`.
- An attachment is listed as `attachments/<file>`.
- An MCP result too large for the context is written under the conversation's directory (`.mikan/mcp-output/`), which is on the host and survives a container replacement; before, it was written under `/workspace`, inside the container only.
- Absolute paths, which every earlier session used, work as before.

## Verification on Slack

A local daemon built from this change, on the `oci` sandbox, was asked in a direct message on a real Slack workspace to create a file by a relative path, print the working directory, and attach the file by the same relative path. `write` created it in the conversation's directory, `bash` printed `/workspace/<office key>` and the file's content, and `attach` uploaded it.
