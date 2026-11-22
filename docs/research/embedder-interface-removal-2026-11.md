# Removing the embedder package interface (2026-11)

The refactor scope ([refactor-scope-2026-11.md](refactor-scope-2026-11.md)) removes the package interface: the root export of `@geminixiang/mikan` and the example that used it. The package becomes the `mikan` CLI.

## What existed

`src/index.ts` exported eight values (`createConversationRuntime`, `createWorkspace`, `createOfficeAddress`, `officeKey`, `createConversationEvent`, `createConversationMessage`, `defaultCommandHandlers`, `MikanModels`) and 21 types. `deploy/examples/embedder` drove a `slack` office over stdin with them. `src/test/public-api.test.ts` snapshotted the export list and `src/test/embedder-example.test.ts` ran the example.

## Readers

| Reader                                                            | Change                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` `main`, `types`, `exports["."]`                    | Removed; `exports` keeps `./package.json`, so a deep `dist/` import still fails                                                                                                                                                                     |
| `package.json` `knip.entry`                                       | `src/index.ts` dropped; knip now reports what only the interface kept alive                                                                                                                                                                         |
| `.config/tsconfig.typecheck.json`, `.config/vitest.config.ts`     | The `@geminixiang/mikan` alias and the example's include are removed                                                                                                                                                                                |
| `src/test/source-guards.boundaries.test.ts`                       | Entry points were the only files allowed to re-export. Now nothing re-exports, the rule against importing through an entry point is gone with the entry point, and a test fails when `package.json` gains `main`, `types`, or another `exports` key |
| `src/tsconfig.build.json`                                         | Stops emitting `.d.ts` and `.d.ts.map`: nothing can import them                                                                                                                                                                                     |
| Docs in four locales, module READMEs, `AGENTS.md`, `CHANGELOG.md` | Describe the package as the CLI                                                                                                                                                                                                                     |

No code under `src/` imported `src/index.ts`; the guard forbade it. The daemon starts from `dist/main.js`, so this change is outside the path a Slack message takes.

## Choices

| Choice                           | Chosen                                    | Alternative                                   | Reason                                                                                                              |
| -------------------------------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `exports` after the removal      | Keep the field with only `./package.json` | Delete `exports`                              | Without the field every file under `dist/` becomes importable, which would be an accidental interface               |
| Type declarations in the package | Stop emitting them                        | Keep emitting                                 | 171 files nobody can import; source maps stay for error reports                                                     |
| Version                          | A breaking change in the 1.6.0 line       | A major version                               | The 1.6.0 betas already carry breaking changes flagged in the changelog; a major is the owner's call                |
| Optional runtime services        | A separate change                         | Make the vault and token stores required here | Three test files rely on the defaults; it is a refactor of the runtime, checked by the test suite, not by this eval |

## Acceptance eval

`.workspace/embedder-removal-eval/run.sh` builds a checkout, packs it, installs the tarball in an empty project, and records what a consumer and a CLI user observe.

| Case                                         | Baseline (a0c02f0a)             | Expected                                   | After                           |
| -------------------------------------------- | ------------------------------- | ------------------------------------------ | ------------------------------- |
| `import "@geminixiang/mikan"`                | Resolves, 8 values              | `ERR_PACKAGE_PATH_NOT_EXPORTED` (accepted) | `ERR_PACKAGE_PATH_NOT_EXPORTED` |
| `require("@geminixiang/mikan/package.json")` | Resolves                        | Resolves                                   | Resolves                        |
| `import "@geminixiang/mikan/dist/main.js"`   | `ERR_PACKAGE_PATH_NOT_EXPORTED` | Same                                       | Same                            |
| `mikan --help` from the installed package    | Exit 0                          | Exit 0                                     | Exit 0                          |
| `mikan --version`                            | 1.6.0-beta.0                    | 1.6.0-beta.0                               | 1.6.0-beta.0                    |
| `dist/index.js` in the package               | Present                         | Absent                                     | Absent                          |
| Declaration files in the package             | 171                             | 0                                          | 0                               |
| Files in the package                         | 688                             | Fewer                                      | 344                             |
| Tarball size                                 | 906 kB                          | Smaller                                    | 818 kB                          |
