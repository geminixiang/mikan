---
title: Remote task executor
description: Run parallel, throwaway commands in a remote sandbox through the remote_task tool.
---

`remote_task` gives the agent a **task executor**: one command, run in a fresh remote sandbox, output returned. It is not a sandbox mode, and it is deliberately not the agent's computer.

The distinction is the subject of [ADR 0002](https://github.com/geminixiang/mikan/blob/main/docs/adr/0002-sandbox-runtime-vs-task-executor.md): a sandbox runtime holds a workspace projection across turns, so files written in one turn are still there in the next. Remote execution cannot do that — sharing a POSIX filesystem over a WAN has no working answer — so it is offered as a tool instead of as `--sandbox=cloudflare:*`, which is no longer accepted.

## Setup

```bash
export CLOUDFLARE_SANDBOX_URL="https://your-bridge.workers.dev"
export CLOUDFLARE_SANDBOX_TOKEN="replace-me" # optional
export CLOUDFLARE_SANDBOX_CWD="/workspace"   # optional, default /workspace
```

The tool appears in the agent's tool list only when `CLOUDFLARE_SANDBOX_URL` is set, so a host without a bridge never advertises a capability it cannot fulfil. You deploy the bridge Worker and its container image yourself — see the [bridge example](https://github.com/geminixiang/mikan/tree/main/examples/cloudflare-sandbox-bridge).

## What each call gets

- **Its own sandbox.** Every call uses a fresh `mikan-task-<uuid>` id, so parallel calls cannot see or disturb each other. That is the point: fan-out work and dynamic workflows.
- **No workspace.** The conversation's files are not mounted. Input arrives in the command; results come back on stdout.
- **No credentials.** The conversation vault belongs to the sandbox runtime. A throwaway remote task gets only what the command itself carries — do not expect `GH_TOKEN` and friends to be present.
- **Nothing afterwards.** The sandbox is discarded when the command finishes. Anything written there is gone.

A command that exceeds the 50 KB output limit is truncated from the tail, and there is nowhere to spill the rest — a task executor has no workspace to write to — so have the command summarise or filter its own output.

## Migrating from `--sandbox=cloudflare:*`

That mode is rejected at startup. Pick a sandbox mode that actually holds the workspace — [`image:<image>`](../sandbox/image/) or [`gondolin:default`](../sandbox/gondolin/) — and keep `CLOUDFLARE_SANDBOX_URL` set if you want the agent to retain remote fan-out through `remote_task`.

Nothing is lost in the move: the mode never mounted the workspace either. `ActorExecutionResolver` resolved mounts and the Cloudflare branch discarded them, the bridge payload has no mount concept, and vault file projection was unsupported. Sessions and `MEMORY.md` were always on the mikan host, never on the remote side.
