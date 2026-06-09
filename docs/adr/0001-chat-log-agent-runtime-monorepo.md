# ADR 0001: Chat Log and Agent Runtime Monorepo Boundary

## Status

Accepted

## Context

mikan's core responsibilities are:

1. Record chat-platform conversations and events reliably.
2. Build the environment an agent needs to consume those messages and act.

The existing single package mixes platform adapters, conversation history, agent runtime, sandboxing, web UI, and CLI bootstrap. This makes it hard to treat conversation history as the source of truth and hard to keep the agent runtime platform-neutral.

## Decision

mikan will move toward a three-package npm workspace layout:

- `@geminixiang/mikan-chat` in `packages/chat`
- `@geminixiang/mikan-agent-runtime` in `packages/agent-runtime`
- `@geminixiang/mikan` in `packages/mikan`

`conversation-id/log.jsonl` is the source of truth for conversation state.

All inbound platform events, agent run events, agent responses, and platform delivery results must be appended to `log.jsonl`.

`packages/chat` owns:

- normalized conversation event schema
- `conversation-id/log.jsonl` append/read APIs
- conversation/session scope projection
- transcript and agent-context projection from the log

`packages/agent-runtime` owns:

- platform-neutral agent context consumption
- prompt/context assembly
- pi-coding-agent integration
- tools, sandbox, vault, and execution environment lifecycle
- platform-neutral agent response/event production

`packages/mikan` owns:

- CLI and application bootstrap
- Slack, Discord, and Telegram adapters
- raw platform event normalization
- platform response delivery
- web/admin/login/session-view surfaces
- wiring `chat` to `agent-runtime` and platform delivery

## Dependency Rules

- `packages/chat` must not import `packages/agent-runtime`, `packages/mikan`, Slack SDKs, Discord SDKs, Telegram SDKs, or pi-coding-agent runtime code.
- `packages/agent-runtime` may import `@geminixiang/mikan-chat`, but must not import Slack SDKs, Discord SDKs, Telegram SDKs, or `packages/mikan`.
- `packages/mikan` is the composition root and may import both workspace packages and platform SDKs.
- Platform adapters convert raw platform events into chat events and convert platform-neutral responses into platform API calls.

## Initial Migration Strategy

The first monorepo split uses exactly three packages. Additional packages such as platform-specific adapters, web, sandbox, or core may be considered later only after the three-package boundary is stable.

Migration should proceed through safe stop points:

1. Record this ADR.
2. Create workspace package skeletons.
3. Move the current app unchanged into `packages/mikan`.
4. Extract chat log/schema/projection into `packages/chat`.
5. Extract platform-neutral agent execution into `packages/agent-runtime`.
6. Keep `@geminixiang/mikan` binary behavior compatible.

## Consequences

This gives mikan a clear event-sourced conversation core and a platform-neutral agent runtime. It also requires path, build, test, CI, and publish workflow updates because the root package becomes a private workspace root and the published CLI package moves to `packages/mikan`.
