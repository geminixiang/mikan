# mikan

Multi-platform AI coding agent for Slack, Telegram, Discord, and GitHub (`@geminixiang/mikan`). Each conversation has an isolated Conversation office: a workspace directory and sandbox runtime. The harness lives in `src/harness/`, built on `pi-agent-core` / `pi-ai`.

TypeScript ESM, Node `>=22.19.0`, `tsgo`, Vitest, `oxlint` + `oxfmt`. Tool configs live in `.config/`.

## Navigation

- `src/README.md` — source index; module READMEs explain local interfaces.
- `CONTEXT.md`, `ARCHITECTURE.md`, `architecture.toml`, `docs/adr/` — domain model and architectural decisions.
- `src/harness/`, `src/agent/` — agent execution; `src/runtime/`, `src/sessions/` — conversation orchestration and persistence.
- `src/adapters/`, `src/adapters/commands/`, `src/cli/` — platform and command entry points.
- `src/office/`, `src/harness/execution-resolver.ts`, `src/sandbox/`, `src/vault/` — office identity and workspace projection, execution resolution, sandbox lifecycle, and credentials.
- `src/test/` — unit/integration tests; `e2e/` — real-platform tests.
- `src/content/docs/` — product docs; `docs/` — internal docs; `deploy/` — deployment assets and examples.

Read the code and documentation relevant to the task; expand the search when the evidence calls for it.

## Commands

| Action                | Command                                       |
| --------------------- | --------------------------------------------- |
| Install               | `npm install --ignore-scripts`                |
| Build / watch         | `npm run build` / `npm run dev`               |
| Focused tests         | `npm test -- src/test/<name>.test.ts`         |
| Full tests            | `npm test`                                    |
| Lint / format check   | `npm run lint` / `npm run fmt:check`          |
| Format selected files | `npx oxfmt -c .config/oxfmtrc.json <paths>`   |
| Exports/dependencies  | `npm run knip`                                |
| Real-platform E2E     | `npm run test:e2e` / `npm run test:e2e:slack` |

Choose verification proportional to the change. Behavior changes need relevant tests; documentation-only changes usually need only formatting and link checks. Run broader checks when shared contracts or cross-module behavior are affected. The pre-commit hook runs the full gate; no need to duplicate it routinely.

## Project contracts

- Follow nearby code and the lint/TypeScript configuration. Local imports use `.js` specifiers. Shared exported types belong in the module's `types.ts`.
- Prefer **LBYL and Early Error Returns**: check preconditions up front, return or throw early for invalid/error cases, and keep the happy path unnested. Use EAFP when check-then-act would race, duplicate expensive work, or make error handling less clear.
- Edit source, not generated `dist/`. `src/index.ts` is the published API; consider its consumers when changing exports.
- Keep session integration easy to upgrade with Pi: delegate session/agent semantics to public `pi-agent-core` interfaces. Do not copy Pi internals, deep-import private `dist` paths, or build speculative compatibility layers. Keep mikan's Office/platform policies separate. Where Pi lacks a public hook, document the small local exception and verify it against native Pi behavior; remove it when upstream exposes the capability.
- Office paths and vault keys use office keys, not raw platform conversation IDs. Derive paths from an `Office` value; see `src/office/README.md` and ADRs 0003–0005.
- Keep credential and mount isolation intact across sandbox backends. Secret file permissions should be explicit. Use `atomicWritePrivateFile` for state that must not be partially visible; reuse `src/file-guards.ts` for optional/schema-validated reads where appropriate.
- Provider-facing tool schemas must have an object root. OpenAI rejects top-level unions, `anyOf`, and `oneOf`; validate alternate invocation modes within the object.
- Every model-facing tool schema must declare a required `label` parameter ("Brief description of this action (shown to user)"). The system prompt promises this unconditionally, and `harness/presenter.ts` renders it as the run's current step in every platform's progress lines; a tool without one either falls back to the bare tool name or, worse, doubles it when the presenter also prefixes the tool name (`jev_browser · jev_browser`). This is easy to drop silently: a tool's declared TypeScript return type does not carry its runtime JSON Schema `required` list, so a missing `label` compiles and passes `execute()`-level tests cleanly. Hand-built tools (`AgentTool`s not adapted from pi-agent-core's native four) get this via `defineHostFnTool` (`harness/tools/host-fn-tool.ts`), which injects it once for every caller — use it, or add `label` to the schema by hand the way `jev.ts`/`attach.ts`/`jev-browser.ts` do. `src/test/tool-label-contract.test.ts` enforces this across the fully assembled tool list (including platform packs) with a documented, narrow exemption list (`start_task`/`task_status`'s fixed tool-level label, `event`'s differently-scoped optional label, and pi's own `read`/`write`/`edit`/`bash` kept optional for cross-ecosystem compatibility) — run it, or extend the exemption list with a recorded reason, rather than letting a new tool silently join the unenforced set.
- Slack Socket Mode delivers an event to only one connected client. Before real Slack E2E, check for competing QA daemons using `docs/testing/slack-e2e.md`. Missing replies require intake evidence, not assumptions about model timeouts.

## Working principles

- Solve the requested problem with the simplest suitable design. Preserve unrelated work and behavior; avoid speculative abstractions and compatibility layers. Surface consequential compatibility changes rather than assuming they are always safe or always forbidden.
- Investigate failures from evidence and verify the original symptom after a repair. Choose reading depth, tools, delegation, and checks to fit the task rather than following a fixed sequence.
- Use the access path the user requests. Ask before switching to UI automation or taking an external/destructive action outside the agreed scope.
- Get approval for dependency additions/upgrades; keep install scripts disabled unless needed and authorized. Real-platform E2E requires authorization and configured credentials.
- Report changes, verification, and material unresolved risks concisely in the user's language. Prefer tables for meaningful implementation decisions (choice, alternatives, rationale) and before/after differences. Include them when they clarify the work, without inventing decisions or forcing a fixed report template.
