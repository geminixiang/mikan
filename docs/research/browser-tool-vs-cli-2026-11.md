# Browser tool or the agent-browser CLI (2026-11)

Question: does `jev_browser` earn its place over giving the model bash with the `agent-browser` CLI (already in the sandbox image) or with Playwright scripts?

Sources: `src/harness/tools/jev-browser.ts`, ADR 0024, ADR 0025, a production deployment's daemon log, and experiments in `.workspace/browser-arms/` on a local daemon with real models through OpenRouter.

## Production usage

The deployment runs a release from before ADR 0025, so `handOff` was never available there.

| `jev_browser` calls (2026-09 to 2026-11)    | Count | Outcome                                 |
| ------------------------------------------- | ----- | --------------------------------------- |
| `url` or `commands` only (the model drives) | 124   |                                         |
| `goal` mode (Jev picks each step)           | 102   | done 27 (26%), blocked 71, step limit 4 |

## Experiment

Three arms, the same mikan runtime and prompt, Slack DM, host sandbox:

- **A**: the tool with goal mode removed and renamed `browser`, plus bash.
- **B**: no browser tool; one workspace note says the `agent-browser` CLI is installed and to start with `agent-browser skills get core`.
- **C**: no browser tool; one note says Node with `playwright-core` and Chrome are available.

Models: `openai/gpt-6-luna` and `anthropic/claude-haiku-5.5`. Total spend about $1.4.

### Simple pages (6 tasks × 2 models × 3 runs)

JavaScript-rendered value, form submit, login then tab, pagination, iframe, screenshot.

| Arm | Success | Median s | Failed tool calls | Median tokens |
| --- | ------- | -------- | ----------------- | ------------- |
| A   | 34/36   | 7        | 1                 | 25.5k         |
| B   | 36/36   | 10       | 7                 | 36.7k         |
| C   | 36/36   | 8        | 14                | 23.7k         |

### Realistic intranet scenarios (7 scenarios, 42 runs per arm)

A mock intranet with server-side state, judged by what changed on the server: two-step login behind a cookie banner, a custom (non-native) role dropdown in a modal, infinite scroll, a coupon found on another page, client-side pagination with a sum, a custom calendar with async time slots, a link that opens a new tab with the answer in an iframe, a follow-up message in the same thread, and two threads browsing at once. Prompts are casual Chinese with incomplete details.

| Scenario      | A     | B     | C     |
| ------------- | ----- | ----- | ----- |
| admin_role    | 1/6   | 4/6   | 6/6   |
| shop          | 4/6   | 5/6   | 6/6   |
| report_sum    | 6/6   | 6/6   | 6/6   |
| booking       | 2/6   | 3/6   | 5/6   |
| docs_iframe   | 6/6   | 6/6   | 6/6   |
| multiturn     | 6/6   | 6/6   | 4/6   |
| concurrent    | 2/6   | 4/6   | 3/6   |
| **Total**     | 27/42 | 34/42 | 36/42 |
| Median tokens | 236k  | 172k  | 86k   |
| Spend         | $0.39 | $0.23 | $0.14 |

## Why the tool loses

- **The CLI's own skill teaches better than the tool's description.** In arm B the model reads `agent-browser skills get core` first and follows it: `snapshot -i` for compact interactive snapshots, and its own named session (`agent-browser session id --scope worktree --prefix …`), which is the per-thread isolation the tool was built to provide.
- **The tool's output invites trust in false success.** `agent-browser select` on a custom `role=combobox` returns `success: true, selected: ["Editor"]` and changes nothing. Inside the tool's structured result the model accepted it and saved; with the CLI the same model checked `get html`, found nothing selected, and clicked the option instead.
- **The tool's output is noisy.** Every command result carries agent-browser's `lifecycle` block, and snapshots are full rather than interactive-only; arm A used the most tokens in both suites.

## What the other arms cost

- Arm C wins on tokens and single-shot tasks, but every script starts a new browser: the follow-up scenario logged in 4–6 times and failed twice, which a real site with two-factor sign-in or a captcha would not allow. It also often skipped the UI and called the mock site's JSON API directly, which real sites guard with CSRF tokens and sessions.
- Arm B is the most even: no state loss across messages, and the CLI's skill keeps its knowledge matched to the installed version.

## Limits

One mock site, two low-cost models, at most six runs per cell; the realistic suite's luna runs are four per cell and haiku two. The office desktop hand-off (ADR 0025) needs a managed sandbox and was not measured.
