---
status: accepted
---

# The host never trusts what the agent can write

The agent is untrusted: it follows instructions from issues, web pages, files, and messages that nobody vetted. A managed sandbox confines it to its own Conversation office. The mikan host process holds much more: every platform and model credential, every office's data, and every vault. The boundary is only as strong as the host code that touches files the agent can change.

## Context

The office directory is mounted read-write into the sandbox, so the agent can replace any entry in it, including with a symbolic link. The office directory itself is a mount point and cannot be replaced from inside the sandbox; entries below it can.

Some host code has treated entries in the office directory as host-owned: it appended to them, rewrote them, followed paths stored in them, or ran programs whose behavior they configure.

## Decision

1. **The host never executes in agent-owned paths.** No host process runs with an agent-owned working directory or reads configuration from one. Operations on repositories the agent works in, such as Git, run inside the sandbox.
2. **The host never follows links in agent-owned paths.** When it reads or writes a file directly inside the office directory, such as the conversation log or `MEMORY.md`, it opens that file without following a final symbolic link and requires a regular file. It writes new files below the office directory only after confirming that no directory on the path is a link.
3. **Records the host rewrites live in the State dir.** Session files move out of the office directory and are not projected into sandboxes. Paths stored inside them are never opened.

The conversation log stays in the office directory, where the agent searches it. The agent can alter its own copy; that grants nothing it could not already do by writing memory.

## Considered Options

- **Move every host record out of the office directory and give the agent a host-side history tool**: removes more surface, but costs a new tool and loses shell access to the log, while rule 2 already makes the log safe.
- **Mount host records read-only into the sandbox**: works for directories, but needs append-only files, strict mount flags, and careful handling of single-file mounts, and still shows session tool output to other public offices.
- **Check each path before use**: Node has no `openat`, so a check followed by an open races with the agent replacing a directory.

## Consequences

- A State migration moves existing session files to the State dir.
- The GitHub adapter stops running Git on the host; the agent clones and pushes inside its sandbox with a Vault credential (ADR 0013). ADR 0015 is amended.
- Host-mode execution is operator-trusted and keeps no such boundary.
