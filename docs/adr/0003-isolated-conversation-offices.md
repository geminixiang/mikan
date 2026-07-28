---
status: accepted
---

# Conversation offices are isolated by default and communicate through the host

A conversation is modeled as an independent office with its own computer and persistent working area. The open-source default locks both the execution environment and conversation files; network access remains unrestricted. A trusted organization may explicitly leave data doors unlocked for convenient access to shared or other conversation data, but every conversation still keeps an independent execution environment. Cross-conversation collaboration must not require opening filesystem access: mikan provides host-mediated calls for request/response delegation, durable messages for asynchronous delivery, and shared bulletins for intentionally published organization information.

## Considered Options

- **Secure-by-default isolated offices with explicit trusted policy (chosen)** — safe for unrelated open-source deployments while preserving the current internal-company collaboration model as an intentional opt-in.
- **One trusted workspace by default** — matches mikan's original internal deployment, where `MEMORY.md`, skills, and events are writable shared surfaces and `private` mainly prevents accidental edits. Rejected as an open-source default because organizational trust cannot be assumed.
- **No cross-conversation communication under isolation** — provides a simple boundary but forces collaboration to reopen filesystem access. Rejected because communication and data access are separate concerns.
- **Restrict the network by default** — rejected for the current model: coding agents require practical network access, while authority is controlled by credential and capability injection rather than network reachability.

## Consequences

- The three policy dimensions are independent: execution environments are always isolated; files are isolated by default and relaxable under an explicit trusted policy; network connectivity is open by default.
- The existing `private` projection is a legacy trusted-office visibility guard, not the target isolated security boundary. New design and documentation must not present it as tenant-grade file isolation.
- Trusted mode is a public, auditable collaboration policy—not a hidden bypass. It may enable shared memory, shared skills, shared events, or cross-conversation data access without weakening runtime isolation.
- Calls and durable messages carry messages, requests, and results—not implicit filesystem rights, credentials, or ownership of another conversation's runtime.
- Authorization for cross-conversation communication belongs in the host control plane. It may eventually derive from Slack, Discord, or Telegram permissions, or from mikan registration and Admin roles; the communication boundary remains valid before a specific authorization source is chosen.
- Network reachability never implies authority. Credentials and sensitive capabilities remain explicitly routed and injected.
