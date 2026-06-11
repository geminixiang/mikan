# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-09

## OVERVIEW

Project: **mikan** (`@geminixiang/mikan`)

mikan is a multi-platform AI coding agent for Slack, Telegram, and Discord. It stores chat logs and session state, runs the `pi-coding-agent` harness, and executes tools in host, Docker, Firecracker, or Cloudflare sandbox modes.

Stack:

- TypeScript, ESM (`"type": "module"`), Node.js `>=22.19.0`
- Build/type emit: `tsgo` via `@typescript/native-preview`, `tsconfig.build.json`
- Tests: Vitest 4, with separate e2e config
- Lint/format: `oxlint`, `oxfmt`
- Platform SDKs: Slack Socket Mode/Web API, Discord.js, grammy for Telegram
- Runtime dependencies include `@earendil-works/pi-*`, Sentry, TypeBox, markdown-it, croner

## STRUCTURE

- `src/`: TypeScript source root.
  - `main.ts`: CLI entrypoint; parses args, loads settings, starts vault/sandbox/runtime/platform bots.
  - `types.ts`: root exported type definitions.
  - `adapter.ts`: platform-neutral bot/message/response interfaces.
  - `agent.ts`: pi-coding-agent runner integration, prompt, tools, memory, sandbox, vault, response flow.
  - `config.ts`: global and per-conversation settings.
  - `runtime/`: conversation/session orchestration.
  - `sessions/`: chat-history sync and persisted session files.
  - `adapters/`: Slack, Discord, Telegram adapters plus shared adapter utilities.
  - `commands/`: chat command parsing and handlers (`login`, `model`, `new`, `session`, `sandbox`, etc.).
  - `sandbox/`: host/container/image/firecracker/cloudflare execution backends.
  - `tools/`: agent tool implementations (`read`, `bash`, `edit`, `write`, `event`, `sandbox`).
  - `vault/`: file-backed credential vault and routing.
  - `web/`: admin, login/OAuth, and session-view portals.
  - `observability/`: Sentry instrumentation.
  - `utils/`: filesystem, env, date, HTML, HTTP-body helpers.
- `test/`: unit/integration tests run by `npm test`.
- `e2e/`: real-platform e2e tests, currently Slack-focused.
- `docs/`: architecture, commands, configuration, deployment, sandbox, sessions, Slack guides.
- `examples/`: Slack app manifests.
- `scripts/`: maintenance and migration scripts.
- `deploy/`, `docker/`: deployment assets and sandbox Dockerfile.
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
- **Types**:
  - All exported `interface`, `type`, and `enum` definitions belong in the nearest `types.ts` (`src/types.ts` for root-level exports; module-local `types.ts` for submodules).
  - Implementation files import exported types from `./types.ts` or `../types.ts`; private non-exported types may stay local.
  - Avoid `any`; inspect dependency types in `node_modules` instead of guessing external APIs.
- **Style**:
  - Existing code uses 2-space indentation, double quotes, semicolons, named functions for non-trivial logic, and top-level imports.
  - Prefer small, surgical functions; project guidance asks to keep functions under ~50 lines where practical.
  - Prefer LBYL validation when reliable; use EAFP only for TOCTOU-prone or clearer error handling.
  - Handle errors explicitly. Do not silently swallow failures.
  - Avoid thin wrappers and unnecessary indirection; reuse existing helpers before adding abstractions.
- **Lint/format**:
  - `oxlint` enforces correctness/suspicious rules as errors and unused vars as errors.
  - `oxfmt` is the formatter.
  - Husky/lint-staged run lint+format on staged `*.ts`; staged `*.test.ts` also triggers tests.
- **Tests**:
  - Add or update Vitest tests in `test/` for behavior changes.
  - E2E tests hit real Slack/Discord/Telegram APIs; do not run unless configured.

## WHERE TO LOOK

- **Source map**: `src/README.md` plus per-subdirectory `README.md` files.
- **Architecture**: `README.md`, `docs/architecture.md`, `docs/sessions.md`, `docs/sandbox.md`.
- **Commands/user behavior**: `docs/commands.md`, `src/commands/`.
- **Platform adapters**: `src/adapters/{slack,discord,telegram}/`.
- **Slack Block Kit/tools**: `src/adapters/slack/tools/`, `test/slack-block-kit-tool.test.ts`.
- **Runtime/session logic**: `src/runtime/`, `src/sessions/`, related tests in `test/session-*.test.ts` and `test/*session*.test.ts`.
- **Sandbox execution**: `src/sandbox/` (SPI, registry, providers incl. Docker provisioner), `src/execution-resolver.ts`, `docs/sandbox.md`.
- **Vault/login/OAuth**: `src/vault/`, `src/web/login/`, `test/login.test.ts`, `test/oauth-link-server.test.ts`.
- **Observability**: `src/observability/`, `src/sentry.ts` compatibility export, `test/sentry.test.ts`.
- **Config**: `src/config.ts`, `docs/configuration.md`, `test/config.test.ts`.
- **Docs for contributors**: `CONTRIBUTING.md`, `CONTEXT.md`, `CHANGELOG.md`.

## NOTES

- Preserve behavior unless explicitly asked to change it; do not remove intentional-looking functionality without asking.
- Read files in full before broad edits or audits. Search snippets are not enough for wide-ranging changes.
- `dist/` is generated from `src/`; edit `src/` and run build instead of modifying `dist/` directly.
- `npm run build` emits declarations and JS to `dist/` and makes `dist/main.js` executable.
- `/login` stores credentials under `--state-dir`; avoid logging secrets and validate state-dir safety.
- Sandbox modes have different credential/mount behavior. Check `docs/sandbox.md` and `src/sandbox/types.ts` before changing executor logic.
- Slack/Discord/Telegram adapters map threads/replies to independent session scopes; check `docs/sessions.md` before changing conversation IDs or session keys.
- Cloudflare AI image input note for related Quro work: send raw base64 strings in `images`, not data URIs, when calling `env.AI.run('openai/gpt-image-2', ...)`.

# Development Rules

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
- Implementation files import types from `./types.ts` (or `../types.ts`) and re-export them for downstream consumers; they do not define exported types inline.
- Private (non-exported) types may stay in the file that uses them.
- Never duplicate a type definition — if a type is needed in multiple files within the same module, it lives in `types.ts`.

## Coding Rules

- Prefer LBYL (Look Before You Leap) in implementation code: validate preconditions before performing operations when those checks are reliable and do not introduce race conditions.
- Use EAFP only when LBYL would introduce TOCTOU races, duplicate expensive work, or make error handling less clear.
- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- Make surgical changes only; avoid unrelated cleanup.
- Preserve existing behavior unless the user explicitly asks to change it.
- Do not remove intentional-looking functionality without asking first.
- Reuse existing helpers and project patterns before adding new abstractions.
- Avoid thin wrappers — functions that only delegate without adding logic, error handling, or meaningful abstraction. Inline them unless they have multiple call sites or encapsulate a non-trivial concern.
- Delete indirection rather than polish it. If behavior is unchanged, always prefer the simpler structure.
- Avoid `any` unless there is no practical typed alternative.
- Check dependency type definitions in `node_modules` instead of guessing external APIs.
- Use top-level imports; avoid inline/dynamic imports for normal code and type references.

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
