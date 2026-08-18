# pi-coding-agent 0.84.2 and pi-agent-core v4 session usage

Research date: 2026-08-17

## Executive conclusion

The premise needs correction: **`@earendil-works/pi-coding-agent@0.84.2` does not use pi-agent-core's v4 session repository for its coding-session persistence.** It depends on `@earendil-works/pi-agent-core@^0.84.2`, but imports `Agent` and related runtime types from it; its own `SessionManager` still owns a synchronous **v3** JSONL format (`CURRENT_SESSION_VERSION = 3`). The v4 implementation exists separately in `@earendil-works/pi-agent-core@0.84.2` under `packages/agent/src/harness/session/`.

Therefore there are two distinct upstream patterns:

1. **coding-agent lifecycle pattern:** one active `AgentSession`/`SessionManager` is replaced in a controlled sequence for resume/new/fork; old work is aborted and torn down before the replacement is applied.
2. **core v4 storage pattern:** each `JsonlSessionStorage` serializes its own mutations with an instance-local promise tail, but `JsonlSessionRepo.open()` creates a fresh independent storage every time. There is no per-path writer registry and no process/file lock for session JSONL.

Mikan commit `5962860` follows the first pattern at runtime and compensates for the second pattern's limitation. A facade-level same-process writer lease is **consistent with upstream's ownership model and necessary for mikan's broader public facade**, although it would be a mikan-owned guard rather than an upstream API convention.

## Source identity and scope

Facts:

- npm reports both latest package versions as `0.84.2` at research time.
- `@earendil-works/pi-coding-agent@0.84.2` declares repository `earendil-works/pi`, directory `packages/coding-agent`, and git commit `914cf1472e715297caa30db4b9535d534a9eb718`.
- `@earendil-works/pi-agent-core@0.84.2` declares the same repository/commit, directory `packages/agent`.
- The coding-agent package declares `@earendil-works/pi-agent-core: ^0.84.2`.

Primary sources:

- [coding-agent npm package](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/0.84.2) and [tarball](https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.84.2.tgz)
- [agent-core npm package](https://www.npmjs.com/package/@earendil-works/pi-agent-core/v/0.84.2) and [tarball](https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.84.2.tgz)
- [`packages/coding-agent/package.json` at the published commit](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/package.json)
- [`packages/agent/package.json` at the published commit](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/package.json)

All upstream paths below refer to that immutable commit. Published `dist/` files in the npm tarballs were also checked against these sources.

## 1. What coding-agent actually persists

### Fact: coding-agent uses its own v3 `SessionManager`

`packages/coding-agent/src/core/session-manager.ts` declares `CURRENT_SESSION_VERSION = 3` and writes a header shaped as `{ type: "session", version: 3, ... }`. It offers its own `create`, `open`, `continueRecent`, `inMemory`, and `forkFrom` factories.

Source: [`session-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L30), class [`SessionManager`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L855), and factories near [`static create/open/continueRecent/inMemory`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L1519).

The coding agent's core SDK imports `Agent`, `AgentMessage`, `setDefaultStreamFn`, and `ThinkingLevel` from agent-core, but receives a coding-agent `SessionManager` and restores/persists through that manager. It does not construct `JsonlSessionRepo`, `JsonlSessionStorage`, or core v4 `Session`.

Source: [`packages/coding-agent/src/core/sdk.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/sdk.ts).

### Fact: construction/open/create are synchronous and lazy-file oriented

- `SessionManager.create(cwd, sessionDir)` creates an in-memory manager state and chooses a future file path.
- It delays durable creation until an assistant message exists; then `_persist()` uses exclusive `openSync(path, "wx")` for first publication.
- `SessionManager.open(path, ...)` reads the existing header/entries and creates one manager around them.
- `continueRecent` finds the latest session and delegates to `open`, or creates a new one.
- `inMemory` uses the same manager with persistence disabled.

Sources: construction and `_persist` in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L855), factories in the same file near line 1519; public examples [`examples/sdk/11-sessions.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/examples/sdk/11-sessions.ts).

Inference: exclusive first creation prevents two managers from both initially publishing the same generated path, but it does **not** make subsequent `appendFileSync` operations coordinate state or parent pointers between two managers that opened the same existing file.

## 2. coding-agent ownership and lifecycle

### Fact: replacement is centralized around one active runtime

`AgentSessionRuntime` owns one current `AgentSession` plus cwd-bound services. For `switchSession`, `newSession`, `fork`, and import it:

1. emits a cancellable before-switch/before-fork event;
2. constructs or opens the target manager;
3. calls `teardownCurrent`, which awaits `session.abort()`, emits `session_shutdown`, invalidates host bindings, then disposes the old session;
4. creates and applies the replacement runtime;
5. rebinds session-local integrations.

Sources: [`AgentSessionRuntime`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-runtime.ts), especially [`teardownCurrent`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-runtime.ts#L167), [`switchSession`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-runtime.ts#L196), [`newSession`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-runtime.ts#L226), and [`fork`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-runtime.ts#L262). See also [`examples/sdk/13-session-runtime.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/examples/sdk/13-session-runtime.ts).

Inference: upstream enforces single ownership by lifecycle topology, not by a reusable per-file lease. Normal CLI operation never intentionally leaves the old writable manager active after switching.

### Resume/switch

Fact: `switchSession` opens a new `SessionManager`, validates the session cwd, then tears down the old session before installing the new runtime. It does not reload one existing manager in place.

### Fork versus branch

Facts:

- A **branch** within a coding-agent v3 session changes the manager's in-memory leaf pointer; subsequent entries become children of the selected entry. `branchWithSummary` additionally appends a branch-summary entry.
- A **fork** through `AgentSessionRuntime.fork` produces/replaces a session. Persistent forks create a new session file containing the selected root-to-leaf path, then tear down the current runtime and create a replacement around the fork.
- Root forks create a fresh session with parent-session metadata.

Sources: `branch`, `branchWithSummary`, and `createBranchedSession` in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts#L1316); runtime fork source above.

### Compaction

Fact: coding-agent computes compaction asynchronously in `AgentSession.compact`/automatic compaction and then synchronously appends the result through `SessionManager.appendCompaction`. The manager remains the one mutation authority for that active session.

Source: [`packages/coding-agent/src/core/agent-session.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session.ts), symbols `compact`, `_runAutoCompaction`, and calls to `sessionManager.appendCompaction`.

## 3. pi-agent-core v4 behavior

### Fact: v4 construction and opening

`JsonlSessionRepo` is the v4 repository:

- `create(options)` prepares a `{ kind: "header", version: 4, ... }`, creates `JsonlSessionStorage`, and returns a `Session`.
- `open(metadata)` loads the path into a **new** `JsonlSessionStorage` and returns a new `Session`.
- `fork(source, options)` loads source state and atomically publishes a destination session.

Source: [`packages/agent/src/harness/session/jsonl/repo.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/harness/session/jsonl/repo.ts), class [`JsonlSessionRepo`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/harness/session/jsonl/repo.ts#L111).

### Fact: mutation ordering is storage-instance local

Every v4 `JsonlSessionStorage` has `private tail: Promise<void> = Promise.resolve()`. `appendEntry`, `appendRecord`, lane moves/creation, name, and label changes all call `enqueue`. `enqueue` chains the operation and preserves a resolved tail after failures. `drain()` awaits that tail.

Source: [`packages/agent/src/harness/session/jsonl/storage.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/harness/session/jsonl/storage.ts#L47), `drain`, mutation methods, and `enqueue`.

Fact: sequence and parent/lane values are derived from the storage instance's loaded `SessionState`, then a mutation is appended and only afterward applied to that instance's state.

Inference: two independently opened handles to one path have two tails and two snapshots. They can calculate the same next sequence and stale lane parent, so instance-local serialization cannot protect the file across handles.

### Fact: create/fork collision guard is not a writer lease

`JsonlSessionRepo.activeCreateDestinations` rejects concurrent same-process **create/fork** operations for the same `{cwd, id}`. It is released as soon as create/fork completes. `open()` does not consult this set, and no active-open registry exists.

Source: [`claimCreateDestination`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/harness/session/jsonl/repo.ts#L174).

### Fact: no session path/process lock was found

Neither the coding-agent v3 `SessionManager` nor core v4 JSONL repository/storage acquires `proper-lockfile` or another path lock for sessions. In coding-agent, `proper-lockfile` is used by settings and auth storage, not session storage.

Sources: [`settings-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/settings-manager.ts) (`FileSettingsStorage.acquireLockSyncWithRetry`); [`auth-storage.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/auth-storage.ts). Absence claims were checked across the published package source/dist for `proper-lockfile`, lock acquisition, `JsonlSessionRepo`, and session paths.

Inference: upstream assumes one active coding-agent process/manager owns a session file; it does not enforce that assumption at the session backend boundary or across processes.

## 4. Read-only inspection

Facts:

- coding-agent's `SessionManager.list`/`listAll` scan and parse files into `SessionInfo`; they do not open a long-lived writable session manager for listing.
- Header/session selection similarly uses direct bounded/header parsing.
- Neither coding-agent `SessionManager.open` nor core v4 `JsonlSessionRepo.open` has a read-only mode. The returned objects expose mutation methods.
- core v4 read query methods (`findEntries`, `findEntriesOnBranch`, `findRecords`, `getLog`, metadata) are non-mutating, but they live on the same writable storage interface.

Sources: listing functions and `SessionManager.list/listAll` in [`session-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/session-manager.ts); v4 [`SessionStorage` types](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/agent/src/harness/session/types.ts) and storage source above.

Inference: mikan should not infer that `open()` means read-only merely because a caller only invokes query methods. A separate mikan snapshot/reader interface would make capability and ownership explicit.

## 5. Settings/session lifecycle distinction

Facts:

- `SettingsManager` has an in-process `writeQueue`, merges only fields modified by the current manager into the latest on-disk state, and wraps read-modify-write with `proper-lockfile`. `flush()` awaits queued writes.
- Session persistence does not copy that locking design.
- During session replacement, runtime services may be recreated against the target cwd; the source explicitly separates cwd-bound service creation from session construction.

Sources: [`settings-manager.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/settings-manager.ts#L294); [`agent-session-services.ts`](https://github.com/earendil-works/pi/blob/914cf1472e715297caa30db4b9535d534a9eb718/packages/coding-agent/src/core/agent-session-services.ts); runtime source above.

Inference: upstream treats settings as shared read-modify-write state requiring explicit coordination, while sessions rely on single active owner plus append-only persistence. This is an architectural ownership assumption, not evidence that concurrent session writers are safe.

## 6. Comparison with mikan and commit `5962860`

### Current mikan shape

Facts:

- `src/harness/session-store.ts` is a mikan facade over core v4 `Session`, `JsonlSessionRepo`, and `JsonlSessionStorage` behavior.
- Every `SessionStore.open(path)` calls `repo().open(...)` and therefore obtains a new v4 storage instance with its own state/tail.
- Pending missing/empty stores carry an independently generated header and `live()` materializes that header before opening it.
- The facade exposes both queries and mutations; it currently has no disposal/release method or per-path lease.

### What `5962860` fixed

Facts from commit `59628607c3c53577cfca4e2395aad424bd0d8451`:

- `PiAgentWrapper.syncChatHistory` changed from `void` to `Promise<void>` and callers now await incremental history sync.
- `ConversationRuntime.getOrCreateState` resolves the expected durable file first and reuses the existing runner when its `sessionFile` matches.
- It refuses switching a running key to another durable file, and discards/recreates only when the durable target changes.
- Added tests cover repeated same-target messages and current/historical/current target switching.

Current sources: [`src/agent.ts`](../../src/agent.ts), [`src/runtime/conversation-runtime.ts`](../../src/runtime/conversation-runtime.ts), [`src/runtime/session-lifecycle.ts`](../../src/runtime/session-lifecycle.ts), and [`src/test/session-runtime.test.ts`](../../src/test/session-runtime.test.ts).

Assessment:

- **Consistent with upstream:** yes. Like `AgentSessionRuntime`, mikan now keeps one live writer for the active target, settles async mutation work before continuing, and replaces ownership only when the target changes.
- **Stronger than coding-agent where needed:** yes. coding-agent's v3 appends are synchronous, while v4 mutations are promises, so awaiting history sync is required to preserve mutation order.
- **Not facade-complete:** also yes. Runtime reuse prevents duplicate handles on known production paths, but direct/public `SessionStore.open/create`, a second runtime/daemon, maintenance code, or simultaneous pending handles can still establish multiple writers.

## 7. Recommendations for mikan

Ordered by value:

1. **Keep `5962860` unchanged as the runtime ownership rule.** It matches upstream's active-runtime replacement model and addresses v4's async mutation semantics.

2. **Add a same-process facade-level writable lease keyed by canonical absolute session path.** Acquire it in writable `open/create` (including pending handles), fail closed or return the already-owned handle, and release it through an explicit async `dispose`/`close`. This is consistent with upstream's one-active-owner topology and analogous in spirit to core's `activeCreateDestinations`, but extends ownership across the full handle lifetime where v4 needs it.

3. **Do not describe that lease as behavior supplied by pi.** It is a mikan invariant compensating for `JsonlSessionRepo.open()` returning independent writable snapshots.

4. **Split read-only inspection from writable ownership.** Prefer bounded header parsing and immutable snapshots for Web/Admin/listing. If full v4 validation/context reconstruction is required, expose a read-only facade/capability that cannot append and does not claim a writer lease. Upstream listing follows this short-lived inspection pattern, but upstream supplies no ready-made read-only v4 handle.

5. **Protect pending materialization.** The lease must start at `open`, not first append; otherwise two missing-file handles can generate different headers and race to overwrite/materialize the same path. Also use exclusive creation or verify the expected header before publication.

6. **Add facade-level two-handle tests.** Cover: existing-file double open, missing-file double open, open versus create, lease release/reopen, concurrent append ordering, and stale pending materialization. Existing runtime tests do not prove facade safety.

7. **Decide process ownership separately.** A same-process lease does not prevent two mikan daemons from opening one office/session. If deployment permits this, add a process-level office lease (or a session-file lock held for writer lifetime). Upstream has no session process lock to inherit.

8. **Await v4 drains before releasing/replacing ownership.** `SessionStore` should expose/forward a drain/close operation so replacement cannot release a lease while queued mutations remain. This follows core v4's `JsonlSessionStorage.drain()` semantics and coding-agent's settle-before-teardown lifecycle.

## Fact/inference boundary summary

| Statement                                                                  | Classification                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| coding-agent 0.84.2 persists v3 through its own `SessionManager`           | Fact                                                                              |
| agent-core 0.84.2 contains a separate v4 repository/storage                | Fact                                                                              |
| each v4 storage serializes only its own queued mutations                   | Fact                                                                              |
| `JsonlSessionRepo.open()` can return multiple writable handles to one path | Fact                                                                              |
| those handles can derive duplicate sequence/stale parent state             | Inference directly from independent loaded state and per-instance tails           |
| coding-agent expects one active owner by runtime topology                  | Inference supported by centralized replacement/teardown                           |
| no session path/process lock exists in these packages                      | Fact from package-wide source search; settings/auth locks are explicit exceptions |
| a mikan facade writer lease is consistent with upstream                    | Architectural recommendation, not an upstream guarantee                           |

## Bottom line

There is no newer coding-agent v4-session integration to copy in `0.84.2`. The useful upstream lesson is its **single active runtime ownership and settle-before-replace lifecycle**. The actual core v4 backend supplies **per-handle async serialization**, not **per-file writer serialization**. Mikan's `5962860` correctly adopts the lifecycle lesson; a facade-level writer lease plus explicit read-only inspection remains the appropriate next hardening step.
