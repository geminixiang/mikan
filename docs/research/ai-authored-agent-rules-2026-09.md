# Agent rules from AI-authored TypeScript projects (2026-09)

Each candidate rule was adopted only when mikan showed a matching defect or risk.

## Sources

| Project       | Guide                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------- |
| pi-mono       | [AGENTS.md @ d6af72e185](https://github.com/badlogic/pi-mono/blob/d6af72e185/AGENTS.md)         |
| OpenClaw      | [AGENTS.md @ da49c7e45c](https://github.com/openclaw/openclaw/blob/da49c7e45c/AGENTS.md)        |
| opencode      | [AGENTS.md @ 696f41bc8e](https://github.com/sst/opencode/blob/696f41bc8e/AGENTS.md)             |
| Gemini CLI    | [GEMINI.md @ 2fe7c2d3f0](https://github.com/google-gemini/gemini-cli/blob/2fe7c2d3f0/GEMINI.md) |
| Kilo Code     | [AGENTS.md @ c267794785](https://github.com/Kilo-Org/kilocode/blob/c267794785/AGENTS.md)        |
| Vercel AI SDK | [AGENTS.md @ 8ff139b734](https://github.com/vercel/ai/blob/8ff139b734/AGENTS.md)                |
| Cline         | [AGENTS.md @ 7645f6a3d4](https://github.com/cline/cline/blob/7645f6a3d4/AGENTS.md)              |

## Adopted

| Rule                                                                                     | Source                           | Evidence in mikan                                                                                                                                                                                        | Change                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Treat order-dependent test failures as defects and reproduce them in the failing order   | OpenClaw, Product and validation | Shuffled runs failed in 6 of seeds 1–11: `github-bot.test.ts` re-pointed the module-level `syncRepo` mock with `mockResolvedValue`, so the PR-head test saw the fetch-only result whenever it ran second | Use `mockResolvedValueOnce`; Vitest now shuffles every run and prints the seed. seeds 12–41 all pass after the fix |
| Several agents share one checkout; stage explicit paths and never stash, reset, or clean | pi-mono, Git                     | Agent sessions in this repository used `git add -A` and `git stash` while Herdr lanes can share the checkout                                                                                             | `AGENTS.md` working principle, with `git worktree add` for comparisons                                             |

## Not adopted

| Rule                                                    | Source              | Reason                                                                                                                                                       |
| ------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No inline `await import()`                              | pi-mono             | Conflicts with measured lazy loading of Discord (38 MB); opencode endorses branch-scoped dynamic imports for startup-heavy modules                           |
| `vi.stubEnv` instead of mutating `process.env` in tests | Gemini CLI          | 154 direct mutations restore state in `afterEach`; test files run isolated and 30 shuffled full-suite seeds found no env leak                                |
| No empty `catch` blocks                                 | Kilo Code           | Most of the 20 production cases are best-effort cleanup (temp files, kills, message deletion, typing); logging them adds noise without a failure to diagnose |
| Parse untrusted JSON through a validating helper        | Vercel AI SDK       | `JSON.parse(...) as` casts exist, but none produced an observed failure; revisit with a concrete defect                                                      |
| Single-word names, no destructuring, no `else`          | Kilo Code, opencode | Style preferences without a mikan defect; oxlint and nearby code already govern style                                                                        |
