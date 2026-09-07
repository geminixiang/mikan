# mikan

Multi-platform AI coding agent for Slack, Telegram, Discord, and GitHub (`@geminixiang/mikan`). Each conversation is a Conversation office: its own workspace directory plus its own sandbox runtime, isolated by default (`CONTEXT.md`, `docs/adr/0003`–`0005`). The agent harness is mikan's own (`src/harness/`, built on `pi-agent-core` / `pi-ai`); tools run under host, container, image, or cloudflare sandbox backends.

Stack: TypeScript ESM, Node `>=22.19.0`, `tsgo` build, Vitest 4, `oxlint` + `oxfmt`. Tool configs live in `.config/`.

## Map

- `src/main.ts` — CLI entry; boot plan, settings, vault/sandbox/runtime, platform bots, events, Dream maintenance.
- `src/harness/` — session store, model catalog, run loop, skills, subagents.
- `src/agent/` — catalog, execution, presentation, prompting.
- `src/runtime/`, `src/sessions/` — conversation/session orchestration and persisted sessions.
- `src/office/` — `OfficeAddress`/office keys, `Workspace`/`Office` layout, office registry, legacy migration.
- `src/adapters/{slack,discord,telegram,github}/` — platform adapters.
- `src/commands/` — chat commands; `manifest.ts` is the single command inventory adapters derive routing from.
- `src/cli/` — argv grammar (`boot.ts`) and subcommands.
- `src/sandbox/`, `src/execution-resolver.ts`, `src/workspace-projection/` — executors, credential/mount resolution, door policy.
- `src/tools/`, `src/mcp/`, `src/vault/`, `src/web/`, `src/observability/`, `src/dream/`, `src/packages/`.
- `src/test/` — all unit/integration tests (`npm test`). `e2e/` — real-platform tests.
- `src/content/docs/` — product docs (Starlight). `docs/` — ADRs, research, testing, reports.
- `deploy/` — pm2 template, sandbox Docker image, examples (Slack manifests, embedder, cloudflare bridge).
- `dist/` — build output; never edit.

Every `src/*/` has a `README.md`; `src/README.md` is the index. Architecture: `ARCHITECTURE.md`, `architecture.toml`.

## Commands

| Action             | Command                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| Install            | `npm install --ignore-scripts` (`prepare` installs Husky; run scripts only when needed) |
| Build / watch      | `npm run build` / `npm run dev`                                                         |
| Test               | `npm test`                                                                              |
| E2E (real tokens)  | `npm run test:e2e`, `npm run test:e2e:slack` — see `docs/testing/slack-e2e.md` first    |
| Lint / format      | `npm run lint`, `npm run lint:fix`, `npm run fmt`, `npm run fmt:check`                  |
| Exports/deps check | `npm run knip`                                                                          |
| Run local build    | `./dist/main.js --state-dir=~/.mikan-dev /path/to/workspace`                            |

The Husky pre-commit hook runs the full gate: lint, fmt:check, knip, build, test.

## Conventions

- Strict TypeScript, ESM, `.js` specifiers for local imports, `node:` for builtins, `import type` for types, no `any` in `src/` (tests exempt). Lint and tsconfig enforce these; don't restate them in code review.
- `.config/oxlintrc.json` carries a frozen exemption list for legacy long functions — shrink it when touching a listed file, never grow it.
- **LBYL and early returns.** Check preconditions up front and return or throw at the top of the function; keep the happy path unnested. Reach for EAFP (try/catch around the operation) only when a check-then-act would race (TOCTOU), duplicate expensive work, or make the error handling less clear.
- Handle errors explicitly; never swallow failures silently.
- State files that readers must not see half-written (settings, session pointers, event JSON, credentials, markers) go through `atomicWritePrivateFile`; optional text/JSON reads and schema-validated parsing go through `src/utils/file-guards.ts`. Otherwise use `node:fs` directly; don't wrap it.
- Secret/vault file permissions stay explicit at the call site.
- Tool parameter schemas exposed to model providers must be object-rooted (`Type.Object`). No top-level union/`anyOf`/`oneOf`: OpenAI rejects them (seen in prod). Model alternate modes as optional properties and enforce exclusivity at runtime.
- Office directories, per-conversation host state, and vault keys are named by office key, never the raw platform conversation id. Derive paths from an `Office` value; raw ids belong at platform I/O boundaries.
- `src/index.ts` is the published package surface (`deploy/examples/embedder/` builds against it). Adding an export there is deliberate.
- Sandbox backends differ in credential and mount behavior: read `src/sandbox/types.ts` and `src/content/docs/sandbox.mdx` before changing executor logic. Session keys and conversation IDs: read `src/content/docs/sessions.mdx` first.
- Slack E2E: Socket Mode delivers each event to one connected client. Before running or interpreting E2E, confirm no other daemon (local pm2, another CI) is on the same QA Slack App; for a missing reply, prove whether the event reached the runner's intake log before touching production code or timeouts.

## Design

- Smallest design that satisfies the current requirement. "Perfect", "long-term", "general", or "must not break anything" do not authorize frameworks, modes, tiers, schemas, or config surfaces beyond it.
- Inside the requested scope, breaking changes are acceptable. Backward compatibility, migrations, legacy fallbacks, and backfills only when the user asks.
- No speculative extensions; if one is worth mentioning, one line at the end.
- Validate once at the owning trusted boundary; downstream trusts that result. No parallel bookkeeping that must be reconciled.
- Reuse before abstracting: check `@earendil-works/pi-agent-core` / `pi-ai` exports before writing a helper. Inline thin wrappers; delete indirection rather than polish it.
- When the user calls something over-engineered, remove it.

### File-split scale

A file earns its existence in exactly one way: **slot** (fills an existing convention axis — one per tool, adapter, command, backend), **authority** (single home of one rule — session-key grammar, command manifest, env manifest), or **weight** (knowledge a reader must absorb together). Function or line count is not a scale. Non-reasons: "for testability", "conceptually different", "might grow later". Read backwards, two files holding one authority should merge.

## Working style

- The user's latest correction wins over earlier instructions; apply it immediately.
- Use the access path the user names (SSH, CLI, API). If it's unavailable, say so before switching. No UI automation unless explicitly asked.
- For breakage: evidence first, one minimal change, verify the original symptom, stop. Diagnose the named system; don't touch neighbours because they could contribute.
- Surgical changes; preserve behavior outside the requested scope and ask before removing intentional-looking functionality there.
- Check `node_modules` type definitions instead of guessing external APIs.
- Dependency and lockfile changes are reviewed code: no adds or upgrades without approval; install with `--ignore-scripts`.
- Answer the question first, then edit. Say whether you agree before saying what changed. Short, direct, technical; match the user's language.
- Report what changed and what verification ran.
