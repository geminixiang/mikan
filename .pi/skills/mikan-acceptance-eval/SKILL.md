---
name: mikan-acceptance-eval
description: Use when a behavior change needs before-and-after acceptance numbers, or the user asks for an eval.
---

# Acceptance eval

An acceptance eval runs the same black-box scenarios against two checkouts, `main` and the change's branch, and prints one result per case. The user accepts the change from the table of baseline, expected, and actual results, so build it before the implementation and leave it unchanged after the user approves it.

[`references/subagent.eval.ts`](references/subagent.eval.ts) is a worked example: the `subagent` tool driven through `SlackMessagingBot` and the conversation runtime with a fake Socket Mode connection, a fake Web API, and Pi's faux provider. Its cases cover the answer a delegated task returns, the limit on delegation, how many children run at once, `stop`, usage, and the session list. It has no upgrade case; `run.sh` runs the test whose name contains "upgrade" twice, first on the checkout that writes the state (`EVAL_UPGRADE_PHASE=create`) and then on the one that reads it (`read`), with `EVAL_UPGRADE_DIR` naming where the state is kept between the two. Start a new eval by copying the `references/` folder.

## Steps

1. **List the cases** from the research doc, each as an outcome a user or the model observes, never an internal call:
   - behaviors the change must keep, as guards;
   - the improvement the change exists for;
   - each accepted regression, stated as such;
   - an upgrade case: state written by `main`, read by the branch;
   - a cost case with a number, such as latency on a large office log.

   Done when every behavior the research says the change touches has a case.

2. **Build** in `.workspace/<topic>-eval/` from the copied references:
   - Import production code only through the `@mikan/` alias, which `vitest.config.ts` points at `$MIKAN_REPO/src`, so one eval file runs against any checkout.
   - Observe only surfaces both checkouts share: platform posts, model-visible tool results, and files in the state directory.
   - Record each result in `results` instead of asserting it, so a regression shows up as a number in the table rather than as a failed run. Use `vi.waitFor` only to wait for an outcome.
   - Make external judgments deterministic, for example by mocking Jev as not configured.
   - Give each scenario its own `World`; a restart is a new runtime and bot on the same state directory.

   Done when it passes on `main`.

3. **Baseline**: `git worktree add ../mikan-eval-base origin/main`, symlink its `node_modules` to this checkout's, and run `run.sh ../mikan-eval-base <out>.json ../mikan-eval-base`.
4. **Agree**: show the user one row per case with the baseline result and the expected result after the change, and wait for approval. These rows are the acceptance criteria.
5. **Verify** after implementing: run `run.sh <branch worktree> <after>.json ../mikan-eval-base`, so the upgrade case reads state that `main` wrote. Report baseline, expected, and actual side by side; every row must match its expected result. Put the table in the PR body.
