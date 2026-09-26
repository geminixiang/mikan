# mikan

Multi-platform AI coding agent for Slack, Telegram, Discord, and GitHub (`@geminixiang/mikan`). Each conversation has an isolated Conversation office: a workspace directory and sandbox runtime. The harness in `src/harness/` is built on `pi-agent-core` / `pi-ai`.

## Where to look

- Domain terms: `CONTEXT.md`. Module map, invariants, and decisions: `ARCHITECTURE.md`, `docs/adr/`.
- Before editing a module, read its `README.md` and its parent module's, if present. A README holds only what the code cannot show: contracts, invariants, and pitfalls. When a contract can be enforced, write a test and keep only the reason in the README.
- Before real Slack E2E, follow `docs/testing/slack-e2e.md`: Socket Mode delivers each event to one connected client, so another daemon on the same app silently answers instead. A missing reply needs intake evidence, not a longer model timeout.

## Commands

`package.json` lists every script. Non-obvious ones:

| Action                | Command                                     |
| --------------------- | ------------------------------------------- |
| Install               | `npm install --ignore-scripts`              |
| Focused tests         | `npm test -- src/test/<name>.test.ts`       |
| Type-check everything | `npm run typecheck` (tests, e2e, examples)  |
| Format selected files | `npx oxfmt -c .config/oxfmtrc.json <paths>` |

Match verification to the change: behavior changes need a test that fails without them; documentation-only changes need formatting and `src/test/doc-references.test.ts`. The pre-commit hook runs the full gate.

## Tests

- In asynchronous tests, act, await the observable outcome (`vi.waitFor` or a deferred gate), then assert. Use elapsed time only when timing is under test, because sleeps pass or fail with machine load.
- Vitest shuffles test order and prints the seed. When a test fails only in some orders, reproduce it with `--sequence.seed=<seed>` and fix the shared state it leaks, for example with `mockResolvedValueOnce` instead of re-pointing a module mock. A rerun that passes proves nothing.
- Inject external clients into the owning operation and keep the production default; replacing process-wide globals leaks between tests.

## Enforced contracts

These rules have guards. When a guard fails, follow the owner or budget it names; change a guard only with a recorded reason.

- Imports come from the declaring module; only `package.json` `exports` entries re-export, and code outside `src/adapters/` reaches adapters only through the composition root (`main.ts`, `cli/`, `runtime/`). Each constant, default, schema, or metadata fact has one owning module. Guards: `src/test/source-guards.*.test.ts`; add a guard class with spelling tables when you give a fact an owner.
- Production double assertions through `unknown` match exact per-file budgets in `src/test/source-guards.boundaries.test.ts`. Lower a budget in the change that removes an assertion; prefer narrowing, a validator, or a typed seam to raising one.
- Every model-facing tool schema requires a `label` parameter, because the system prompt promises it and the presenter shows it as the run's current step; the TypeScript type does not carry the JSON Schema `required` list, so a missing label compiles. Use `defineHostFnTool`, which injects it. Guard: `src/test/tool-label-contract.test.ts`, whose exemptions each carry a reason.
- Provider-facing tool schemas have an object root, because OpenAI rejects top-level unions, `anyOf`, and `oneOf`; validate alternate invocation modes inside the object.

## Design rules

- Keep object shapes stable: write `field: condition ? value : undefined` when absent and `undefined` are equivalent, and keep a conditional spread only where the property must be absent, such as for an `in` check.
- Put shared exported types in the module's `types.ts`. Use a named options interface when a signature spans several lines or crosses a module boundary; call the underlying function instead of adding a pass-through helper.
- Check preconditions first and return or throw early, keeping the happy path unnested; use EAFP when check-then-act would race or duplicate expensive work. For subprocesses, handle both the startup `error` event and exit, and keep the command or path in the error, because a missing executable otherwise escapes as an unhandled error.
- Delegate session and agent semantics to public `pi-agent-core` interfaces so mikan upgrades with Pi. Deep imports of Pi's private `dist` paths and copies of Pi internals break on upgrade; where Pi lacks a public hook, document the small local exception, verify it against native Pi behavior, and remove it once upstream exposes the capability.
- Derive office paths and vault keys from an `Office` value, never from raw platform conversation IDs (ADRs 0003–0005). Keep credential and mount isolation intact across sandbox backends, set secret file permissions explicitly, and write state that must not be partially visible with `atomicWritePrivateFile`.
- Name the need a comment would explain in a file or function instead; the urge to comment signals a split responsibility or unclear name.
- Solve the requested problem with the simplest design. Leave unrelated behavior unchanged, add no speculative abstraction or compatibility layer, and state consequential compatibility changes in the report.

## Boundaries

- This repository is public. Commits, docs, tests, issues, PRs, and release notes use placeholders such as `C0123456789`, `acme`, and `example.com` in place of real organizations, customers, people, hosts, and Slack workspace, channel, user, or message IDs or links; describe production evidence without identifiers.
- Other agents may share this checkout. Stage explicit paths for your own changes, and compare against a commit with `git worktree add`. `git add -A`, `git add .`, `git stash`, `git checkout .`, `git reset --hard`, and `git clean` capture or discard work you did not make.
- Get approval before adding or upgrading a dependency, running install scripts, running real-platform E2E, switching to UI automation, or taking an external or destructive action outside the agreed scope. Use the access path the user requests.
- Treat review comments from bots and review agents as evidence: fix those that identify a real bug, contract gap, security issue, or violation of these rules, and give a one-line reason for each one you decline.

## Reporting

Report changes, verification, and unresolved risks concisely in the user's language. Use tables for implementation decisions (choice, alternatives, rationale) and before/after differences when they clarify the work.
