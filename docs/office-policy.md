# Office authorization policy

This is the target contract for the Office refactor, not a claim that the current
release enforces it. Implementation progress and remaining bypasses are listed
below. Production migration and deployment require separate approval.

## Principals and scope

An Office identifies data and execution resources; its address is not a grant.
Every operation distinguishes the authenticated actor, source Office, target
Office, credential principal, and result audience. A platform user ID supplied in
an event file or model argument is not authentication. A private reply is a
confidential delivery mechanism, not proof of administrative authority.

Public sharing is confined to an explicitly established organization/installation
sharing domain. Merely residing in the same deployment, using the same platform,
or having the same raw conversation ID does not establish that domain. Unknown
and externally shared channels are excluded until explicitly authorized.

## Data policy

| Resource                                                       | Default access                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Own Office working files                                       | Read/write, including execution of code using authorized capabilities   |
| Other eligible public Office working files                     | Read-only within the same sharing domain                                |
| Other private Office or DM working files                       | Denied                                                                  |
| Session/control records, pending events, settings, credentials | Not public working files; separately scoped capabilities required       |
| Shared skills and other published guidance                     | Readable in the sharing domain; publication requires explicit authority |

Public working files include intentionally public project files and Office memory,
not automatic publication of raw session transcripts, execution traces, or secrets.
Legacy shared memory/skills require provenance review before publication; existing
contents cannot be assumed public. File read permission cannot prevent executing
readable scripts with an interpreter. Unix execute bits are not a capability system.

## Operations

| Operation                                                                                                | Required authority                                                                        |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Ordinary work in the source Office                                                                       | Authenticated platform admission or a narrowly issued work capability                     |
| Cross-Office project work                                                                                | Explicit actor-to-target work grant; never inferred from public visibility                |
| Cross-Office settings, scheduling, task control                                                          | Explicit actor-to-target management grant                                                 |
| Reading private target data / returning it to a DM                                                       | Explicit data grant and authorized destination; work/management does not imply disclosure |
| Deployment configuration, grants, sandbox isolation, shared Vault administration, host MCP configuration | Deployment operator only                                                                  |

A deployment operator is explicitly configured in host-authoritative state; bot
access, Slack administrator status, possession of an arbitrary session link, and
legacy `full` configuration do not automatically confer this role. Administrative
power does not automatically grant browsing other people's DMs.

DM is a supported request and response surface for managing public Offices,
including project work and schedules. This must use target-scoped authorization,
not writable mounts of every Office. Target-side execution versus a restricted
file operation interface remains an implementation decision. Neither may silently
inherit target credentials or bypass target work coordination. Private-target
management requires explicit grants; it is not enabled merely to preserve legacy
`full` behavior.

## Host capabilities and scheduled work

- The host enforces authorization before effects; tool descriptions and prompt
  instructions are not checks. Native Pi tool semantics remain unchanged.
- Ordinary event tools expose only the current Office's events. Exact platform
  and conversation identity are required; absent/ambiguous ownership fails closed.
  Knowing a filename or requesting `scope=all` is not a cross-Office grant.
- Event records are host-authoritative admitted work, not a shared writable message
  bus. Persist authenticated origin and bounded authority separately from task text.
  Recheck authorization before scheduled execution. Deletion/cancellation must
  prevent not-yet-started work; work already executing needs an explicit stop result.
- Host readers must enforce containment when following agent-controlled filesystem
  data. Symlinks and session filenames cannot expand an issued capability.
- MCP command configuration is host execution administration. Target Office work
  permission alone cannot create or test arbitrary host processes.

## Links, credentials, and revocation

- Automatically published viewer/overflow links are read-only and bounded to the
  material being shared. They do not grant execution as their issuer or management
  of the issuer's Office. Interactive work requires separately authorized capability.
- Issued tokens must retain consistent actor, platform, target, actions, expiry,
  and revocation semantics. Existing streams cannot outlive authorization silently.
- Work grants do not automatically authorize all Office credentials. Shared Vault
  copies and external MCP policies require explicit provisioning and revocation.
- Check grants at admission, before execution, and before disclosure. Revocation
  blocks new effects and closes affected access paths. Running effects may need
  cancellation and external-outcome-unknown reporting; do not promise rollback.
- Unmounting is not erasure. Container layers, copied secrets, transcripts, and
  already delivered results require separate retention/migration decisions.

## Implementation and migration status

This document defines the target, not a release security guarantee.

| Area                                                               | Status                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Event tool ownership and enumeration                               | Exact-owner checks for list/read/update/delete; global enumeration denied |
| Filesystem event bus and watcher execution authorization           | Not migrated; still a separate bypass                                     |
| Operator and actor-to-target grants                                | Not implemented                                                           |
| Public working-data projection / sharing-domain metadata           | Not implemented                                                           |
| Admin, door, login, MCP operation gates                            | Not implemented                                                           |
| Viewer capabilities and host reader containment                    | Not implemented                                                           |
| Credential revocation, event cancellation, running-work revocation | Not implemented                                                           |
| Production legacy settings and data                                | Unchanged                                                                 |

The first event-tool slice is not an atomic authorization store: its ownership
read and subsequent mutation can race a filesystem writer, and timestamp-based
creation can overwrite a colliding filename. These remain explicit blockers to
claiming the event system implements this policy. Read-check-write on a shared
writable bus is not the final design.

Missing grants deny access in the target model. Migration must first inventory real
cross-Office use, establish operators and explicit grants, separate working data
from control records, and invalidate unsafe capabilities. Do not translate legacy
`full` into wildcard grants, silently trust historical event user IDs, or retain a
permanent trusted-mode bypass. Do not deploy a partial implementation as complete
Office isolation.

## Local verification contract

Test through accepted interfaces: command handlers and real loopback Admin HTTP;
Admin to a harmless local stdio MCP server; real event store/watcher with a fake
platform receiver; real Session View/file-preview HTTP with synthetic sessions and
symlinks pointing only at temporary fixtures. No production data, external platform
requests, model calls, or real credentials. Bind servers to loopback and clean up
processes, files, environment changes, and timers.

For each slice, first demonstrate a failing denial test, implement the smallest
coherent enforcement change, then run positive and negative regressions. Track
what remains reachable through other entry points rather than declaring a tool
check to be a system-wide authorization guarantee.
