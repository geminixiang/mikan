# PROJECT KNOWLEDGE BASE

## OVERVIEW

Project: **mikan** (`@geminixiang/mikan`)

mikan is a multi-platform AI coding agent for Slack, Telegram, Discord, and GitHub. It stores chat logs and session state, runs mikan's own agent harness (`src/harness/`, built on `pi-agent-core` and `pi-ai`), and executes tools in host, Docker, or Cloudflare sandbox modes. Each conversation is a Conversation office: its own workspace directory plus its own sandbox runtime, isolated by default (`CONTEXT.md`, `docs/adr/0003`–`0005`).

Stack:

- TypeScript, ESM (`"type": "module"`), Node.js `>=22.19.0`
- Build/type emit: `tsgo` via `@typescript/native-preview`, `src/tsconfig.build.json` (tool configs live in `.config/`; root `tsconfig.json` stays for editor discovery)
- Tests: Vitest 4, with separate e2e config
- Lint/format: `oxlint`, `oxfmt`
- Platform SDKs: Slack Socket Mode/Web API, Discord.js, grammy for Telegram
- Runtime dependencies include `@earendil-works/pi-*`, Sentry, TypeBox, markdown-it, croner

## STRUCTURE

- `src/`: TypeScript source root (unit/integration tests live in `src/test/`, run by `npm test`).
  - `main.ts`: CLI entrypoint; executes the boot plan, loads settings, starts vault/sandbox/runtime/platform bots.
  - `types.ts`: root exported type definitions.
  - `adapter.ts`: platform-neutral bot/message/response interfaces.
  - `agent/`: agent catalog, execution, presentation, prompting, and runner integration.
  - `harness/`: mikan's agent harness (session store, model catalog, run loop, skills, bounded subagents) built on `pi-agent-core`/`pi-ai`.
  - `mcp/`: settings-declared MCP server connections and tool wrapping.
  - `config.ts`: global and per-conversation settings.
  - `cli/`: argv grammar (`boot.ts`) and the subcommands that run instead of the daemon (`ext`, `office`, `env`, `--download`).
  - `office/`: the Conversation office module — `OfficeAddress`/office keys, the frozen `Workspace`/`Office` layout values, the office registry journal, and the boot-time legacy migration.
  - `runtime/`: conversation/session orchestration.
  - `sessions/`: chat-history sync and persisted session files.
  - `adapters/`: Slack, Discord, Telegram, and GitHub adapters plus shared adapter utilities.
  - `commands/`: chat command parsing and handlers (`login`, `model`, `new`, `session`, `sandbox`, etc.); `manifest.ts` is the single command inventory that adapters derive registration/routing from.
  - `sandbox/`: host/container/image/cloudflare execution backends.
  - `execution-resolver.ts`: resolves the concrete executor, credential key, and mounts for an actor plus office.
  - `workspace-projection/`: resolves an office's door policy into concrete sandbox mounts and authorized prompt sources.
  - `packages/`: git/host-directory packages that ship read-only skills into a deployment.
  - `tools/`: agent tool implementations (`read`, `bash`, `edit`, `write`, `event`, `sandbox`).
  - `vault/`: file-backed credential vault and routing.
  - `web/`: admin, login/OAuth, and session-view portals.
  - `observability/`: Sentry instrumentation.
  - `utils/`: filesystem, env, date, HTML, HTTP-body helpers.

- `e2e/`: real-platform e2e tests, currently Slack-focused.
- `src/content/docs/`: Starlight documentation source (architecture, commands, configuration, deployment, sandbox, sessions, Slack guides).

- `docs/`: repository-internal documentation — `adr/` (accepted architecture decisions), `research/`, `testing/`, `reports/`. Product documentation lives in `src/content/docs/`.
- `.config/`: tool configuration — Vitest (unit + e2e), oxlint, oxfmt, Astro.
- `scripts/`: maintenance and migration scripts.
- `deploy/`: deployment assets — `pm2/` process template, `docker/` sandbox image, and `examples/` (Slack app manifests, embedder, cloudflare bridge).
- `dist/`: generated build output; do not edit manually.

## COMMANDS

| Action                   | Command                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| Install                  | `npm install --ignore-scripts` (use scripts only when explicitly needed; `prepare` installs Husky) |
| Build                    | `npm run build`                                                                                    |
| Dev/watch build          | `npm run dev`                                                                                      |
| Test                     | `npm test`                                                                                         |
| E2E tests                | `npm run test:e2e` or `npm run test:e2e:slack` (requires real platform tokens/workspace)           |
| Lint                     | `npm run lint`                                                                                     |
| Lint fix                 | `npm run lint:fix`                                                                                 |
| Format                   | `npm run fmt`                                                                                      |
| Format check             | `npm run fmt:check`                                                                                |
| Dependency/exports check | `npm run knip`                                                                                     |
| Clean build output       | `npm run clean`                                                                                    |
| Run local build          | `./dist/main.js --state-dir=~/.mikan-dev /path/to/workspace`                                       |

## CODING STANDARDS

- **Language**: strict TypeScript targeting ES2023 with Node16 module resolution. Use ESM imports/exports and `.js` import specifiers for local TS modules.
- **Style**:
  - Existing code uses 2-space indentation, double quotes, semicolons, and named functions for non-trivial logic.
  - Keep functions under ~50 lines where practical.
  - Handle errors explicitly. Do not silently swallow failures.
- **File I/O**:
  - Use Node `fs` / `fs/promises` directly for ordinary reads, writes, directory scans, streams, and watchers; do not add a generic FileIO wrapper just to hide `fs`.
  - Reuse `src/utils/file-guards.ts` for common optional text/JSON reads and schema-validated JSON parsing instead of hand-rolling `try readFile + JSON.parse` in multiple places.
  - Use `atomicWritePrivateFile` for important state files where readers must not see partial content, especially settings, session pointers, event JSON, credentials, and marker files.
  - Use append APIs directly for append-only JSONL logs; add an in-process guard or domain lock when duplicate concurrent appends would corrupt semantics.
  - For read-modify-write state shared across requests/processes, prefer a small domain-specific lock/storage backend, following pi's settings/auth pattern, not a broad filesystem abstraction.
  - Keep secret/vault file permissions explicit at the call site (`mode`, `chmod`, private directories); do not hide security semantics inside generic helpers.
  - Use `dirname(path)` for parent directory creation. Avoid path tricks like `join(path, "..")`.
  - Keep `fs.watch`, streams, binary attachment writes, and sandbox/temp-file handling close to their call sites unless repeated behavior proves a helper is needed.
- **Lint/format**:
  - `oxlint` enforces correctness/suspicious rules as errors, plus: no unused vars, no import cycles, max block depth 4, no `any` in production src (tests exempt), `import type` for type-only imports, `node:` protocol on builtin imports, and — for new code — max 100 lines per function and max 5 parameters. The legacy offenders are frozen in an exemption list in `.config/oxlintrc.json`; shrink that list when refactoring a file on it, never grow it.
  - TypeScript runs with `strict` plus `noUncheckedIndexedAccess` (tests exempt via `src/test/tsconfig.json`), `verbatimModuleSyntax`, `noImplicitOverride/Returns`, and `noFallthroughCasesInSwitch`.
  - `oxfmt` is the formatter.
  - The Husky pre-commit hook runs the full gate: `lint`, `fmt:check`, `knip`, `build`, `test`.
- **Tests**:
  - Add or update Vitest tests in `src/test/` for behavior changes.
  - E2E tests hit real Slack/Discord/Telegram APIs; do not run unless configured.

## WHERE TO LOOK

- **Source map**: `src/README.md` plus per-subdirectory `README.md` files.
- **Architecture**: `architecture.toml`, `ARCHITECTURE.md`, module-local `src/*/README.md`; user-facing architecture: `src/content/docs/architecture.md`.
- **Conversation office vocabulary and identity**: `CONTEXT.md`, `docs/adr/0003-isolated-conversation-offices.md`, `docs/adr/0004-persistent-offices-and-ephemeral-factory-floors.md`, `docs/adr/0005-office-address-identity.md`, `src/office/README.md`, tests in `src/test/office-*.test.ts`.
- **Chat commands**: `src/commands/README.md`, `src/commands/manifest.ts`, `src/content/docs/commands.mdx`.
- **CLI grammar/subcommands**: `src/cli/README.md`, `src/cli/boot.ts`.
- **Platform adapters**: `src/adapters/{slack,discord,telegram,github}/`.
- **Slack Block Kit/tools**: `src/adapters/slack/tools/`, `src/test/slack-blockkit-tool.test.ts`.
- **Runtime/session logic**: `src/runtime/`, `src/sessions/`, related tests in `src/test/*session*.test.ts`.
- **Sandbox execution**: `src/sandbox/`, `src/execution-resolver.ts`, `src/provisioner.ts`, `src/content/docs/sandbox.mdx`.
- **Door policy / workspace mounts**: `src/workspace-projection/`, `src/test/workspace-projection.test.ts`.
- **Vault/login/OAuth**: `src/vault/`, `src/web/login/`, `src/test/login.test.ts`, `src/test/oauth-link-server.test.ts`.
- **Observability**: `src/observability/` (`sentry.ts`, `instrument.ts`), `src/test/sentry.test.ts`.
- **Config**: `src/config.ts`, `src/content/docs/configuration.md`, `src/test/config.test.ts`.
- **Docs for contributors**: `CONTRIBUTING.md`, `CONTEXT.md`, `CHANGELOG.md`.

## NOTES

- `dist/` is generated from `src/`; edit `src/` and run build instead of modifying `dist/` directly.
- `npm run build` emits declarations and JS to `dist/` and makes `dist/main.js` executable.
- `/login` stores credentials under `--state-dir`; avoid logging secrets and validate state-dir safety.
- Sandbox modes have different credential/mount behavior. Check `src/content/docs/sandbox.mdx` and `src/sandbox/types.ts` before changing executor logic.
- Slack/Discord/Telegram adapters map threads/replies to independent session scopes; check `src/content/docs/sessions.mdx` before changing conversation IDs or session keys. GitHub maps one issue or PR to one conversation.
- Office directories, per-conversation host state, and conversation vault keys are named by office key, never by the raw platform conversation id. Derive paths from an `Office` value (`workspace.office(address)`), and leave the raw-id mapping to the office registry; raw ids belong at platform I/O boundaries.
- `src/index.ts` is the published package interface (the embedder in `deploy/examples/embedder/` builds against it). Adding an export there widens the npm surface — keep the list explicit and deliberate.

# Development Rules

## Problem Framing and Tool Choice

- Before the first tool call, identify the exact target, failure direction, and requested access path.
- Apply the user's latest task correction immediately; it overrides conflicting earlier user instructions and assumptions while preserving unaffected requirements.
- Use the access path the user names, such as SSH, CLI, or API. If that path is unavailable, report it before switching paths. Use Computer Use, desktop UI automation, screen control, or synthetic clicks and keystrokes only when the user explicitly requests UI operation for the current task.
- Diagnose the named system first; do not inspect or modify adjacent tools merely because they could contribute to the symptom.
- For troubleshooting, gather evidence before mutation, make one minimal change, verify the original symptom, then stop further mutation and run only the required checks.
- When the target or direction is genuinely ambiguous, ask one short clarification question before operating external systems.

## Conversational Style

- Keep answers short and concise.
- No fluff or cheerful filler text.
- Technical prose only; be kind but direct.
- Match the user's language when practical.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or analysis, explicitly say whether you agree or disagree before saying what changed.

## Type Organization

- All exported `interface`, `type`, and `enum` definitions live in `types.ts`.
- Root-level exported types live in `src/types.ts`. Each sub-module (`adapters/`, `sessions/`, `runtime/`, etc.) has its own `types.ts`.
- Implementation files import types from `./types.js` (or `../types.js`) and re-export them for downstream consumers; they do not define exported types inline.
- Private (non-exported) types may stay in the file that uses them.
- Never duplicate a type definition — if a type is needed in multiple files within the same module, it lives in `types.ts`.

## Design Simplicity

- Implement the smallest design that satisfies the current requirement. Quality goals such as "perfect", "long-term", "general", or "must not affect anything" do not authorize frameworks, extension points, modes, tiers, schemas, or configuration beyond that requirement.
- Inside the requested scope, assume breaking changes are acceptable. Add backward compatibility, migration, legacy fallback, or old-data backfill only when the user explicitly requests it.
- Do not implement future extensions speculatively. If one is relevant to mention, limit it to a one-line final note.
- Use engineering judgment directly. Do not add validators, closed error-code sets, alias tables, or rule engines to mechanize decisions that instructions and review already cover.
- Perform each validation, check, or probe once at its owning trusted boundary. Downstream code relies on that result unless it crosses a new untrusted boundary or the guarantee is invalidated; do not duplicate it across layers or maintain parallel bookkeeping that must be reconciled.
- Before writing code that adds an abstraction layer, a configuration surface, more than about five new files, or any speculative option, present the minimal version and those additions separately; default to the minimal version.
- VibeGuards U-17/U-29 strictness applies to real error paths within the requested change; it does not justify new validators, checks, compatibility layers, or fallback paths.
- When the user calls a design over-engineered, remove the excess rather than defending or polishing it.

## Coding Rules

- Prefer LBYL (Look Before You Leap) for preconditions that remain the responsibility of the current boundary and can be checked without introducing a race.
- Use EAFP when LBYL would introduce TOCTOU races, duplicate expensive work, or make error handling less clear.
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Make surgical changes only; avoid unrelated cleanup.
- Preserve behavior outside the requested change, and do not remove intentional-looking functionality outside that scope without asking first. Inside the requested scope, follow the breaking-change default above.
- Reuse existing helpers and project patterns before adding new abstractions. For general-purpose helpers, check `@earendil-works/pi-agent-core` / `pi-ai` exports first — do not reimplement what the harness's own dependencies already ship (mikan's `truncate.ts` was an aging copy of pi's).
- Avoid thin wrappers — functions that only delegate without adding logic, error handling, or meaningful abstraction. Inline them unless they have multiple call sites or encapsulate a non-trivial concern.
- Delete indirection rather than polish it. If behavior is unchanged, always prefer the simpler structure.
- Do not use `any` in production `src`; in tests, avoid it unless there is no practical typed alternative.
- Check dependency type definitions in `node_modules` instead of guessing external APIs.
- Use top-level imports; avoid inline/dynamic imports for normal code and type references.
- Tool parameter schemas exposed to model providers must be object-rooted (`Type.Object` / top-level `type: "object"`). Do not use a top-level `Type.Union`, `anyOf`, or `oneOf`; OpenAI function tools reject schemas whose root is not explicitly an object. Represent alternate invocation modes as optional object properties, then enforce exclusivity and required-mode rules in runtime validation.

## File-Split Scale

A file split is a classification, and classification needs a scale — over-splitting is an error, not a style preference. Code written as piles of one-off-script files resists composition into larger architecture. A file earns its existence in exactly one of three ways:

- **Slot**: it fills an existing convention axis (one file per tool, adapter, command handler, sandbox backend). The classification already exists; the file fills a slot without creating a new concept.
- **Authority**: it is the single home of one rule (the session-key `:` grammar, the command manifest, the env manifest). Deleting it would make N callers each grow a diverging copy of the rule.
- **Weight**: it holds knowledge a reader must absorb together. Function count and line count are not scales — two functions spanning 1000 lines can be a deep module; a 13-line single-use wrapper file is not.

Non-reasons to split: "for testability" (test through the interface, not the file boundary); "conceptually different" (things that always change together live together); "might grow later" (split when it grows — splitting later is cheap, merging back is expensive because imports have already spread).

The same scale read backwards finds merge candidates: two files implementing one authority (duplicate rules drifting apart) should collapse into one home.

## Verification

- After code changes, run the relevant test or check command.
- If unsure which command applies, inspect `package.json` first.
- For documentation-only changes, tests are not required unless requested.
- Report what was changed and what verification was run.

## Dependency and Install Security

- Treat dependency and lockfile changes as reviewed code.
- Do not add or update dependencies without user approval.
- Use `npm install --ignore-scripts` or `npm ci --ignore-scripts` unless lifecycle scripts are explicitly required.

## User Override

- If the user's instructions conflict with this document, ask for explicit confirmation before overriding.
