# What delegation costs: subagent, background task, fork (2026-10)

Question: for complex requests, does handing work to a subagent or a background task make mikan faster, more correct, or cheaper than the conversation doing the work itself, and would Pi's `fork` do better than today's "new conversation plus a brief"?

Sources: `src/harness/subagent.ts`, `src/harness/tools/task.ts`, `src/sessions/session-store.ts` (`reportTaskOutcome`), `src/harness/prompt.ts` (Slack Tasks section), ADR 0020, ADR 0021, pi-durable 1.3.0 README (forks, subagents, `toolExecution`), its example `23-subagent-background.ts`, pi-ai 1.3.0 `openai-completions.js` and `openai-responses.js` (cache keys), and [durable-bench](https://github.com/badlogic/durable-bench) for method. Experiments are under `.workspace/task-replace-eval/` (`RESULTS-2026-10-17.md`), `.workspace/fork-cache/` and `.workspace/mech-bench/` (each with `RESULTS.md`). Real-platform runs used a local daemon on `main`, a real Slack workspace with two human accounts, and `cliproxyapi` (`gpt-6-luna`, openai-completions). Costs use assumed prices (input 1.25, cached 0.125, output 10 USD per 1M) and serve comparison only.

## What exists today

| Mechanism    | Where              | How the child starts                                                                                  | Parent while it runs                                                                                         |
| ------------ | ------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `subagent`   | every conversation | new task-owned conversation, lean prompt, a brief per task; several run at once                       | blocked in the tool call                                                                                     |
| `start_task` | top-level Slack DM | new conversation owned by an anchor task, full system prompt, one brief; the thread is its Slack home | free; the result is written back to the DM main as a `write` (no model turn) and the thread gets an @mention |
| Pi `fork`    | not used           | copies the parent's transcript up to an entry; fresh provider session identity                        | —                                                                                                            |

The DM prompt tells the model to use `start_task` for every multi-step request. Production (read-only): 1,030 subagent calls in three months, 40% from channels, median run 126 s; `start_task` is not deployed.

## Experiments

### 1. Real tasks, same office, delegate vs direct (3 reps each)

Task C4: clone three open-source repos at given tags, install, run only the test framework, report 14 facts. Each rep used a different tag set with answers computed beforehand.

| Setting                                   | Final reply       | Correct    | Cost            | Conversations                     |
| ----------------------------------------- | ----------------- | ---------- | --------------- | --------------------------------- |
| DM, `start_task` (prompt default)         | 114 / 96 / 145 s  | 14, 12, 14 | $.033 .069 .076 | 2                                 |
| DM, told to do it directly                | 118 / 125 / 171 s | 14, 14, 14 | $.018 .052 .047 | 1                                 |
| Channel, model's choice (did it directly) | 54 / 82 / 66 s    | 14, 14, 14 | $.031 .054 .032 | 1                                 |
| Channel, told to use 3 parallel subagents | 148 / 175 / 122 s | 12, 12, 14 | $.105 .146 .107 | 5 (subagent called twice per run) |

Delegation in the DM changed speed within noise and added about 50% cost. Parallel subagents in the channel were 2.2× slower, 3× dearer, and less correct.

### 2. Why parallel subagents lose: one sandbox

Measured inside a mikan sandbox container (1 CPU, 512 MB): three `git clone && npm install` one after another took 124 s; the same three at once took 316 s and one `npm install` was OOM-killed. Subagents promise parallelism the sandbox cannot provide for CPU- or memory-bound work.

### 3. Work that can run in parallel (3 × `sleep 90`, no CPU; 3 reps)

| Setting                            | Final reply       | Cost              |
| ---------------------------------- | ----------------- | ----------------- |
| DM, `start_task`                   | 114 / 107 / 289 s | $.037 .035 .049   |
| DM, direct                         | 102 / 100 / 286 s | $.0185 .0184 .021 |
| Channel, model chose subagents     | 115 / 108 / 109 s | $.081 .028 .031   |
| Channel, forced parallel subagents | 107 / 108 / 112 s | $.029 .026 .030   |

Pi runs one turn's tool calls in parallel (`toolExecution` defaults to `"parallel"`). When the model issued the three commands in one turn, direct matched subagents on speed at half the cost; in one rep of three it issued them one per turn and took 3×. Two prompt lines that state these facts (commands in one turn run together; the container is small) were tried on a branch (`exp/prompt-parallel`): the sequential rep still happened, and the channel delegated more often, not less (cost $.039 → $.135). Not adopted.

### 4. Provider cache: fork vs new conversation (real provider, 3 trials each, 12k-token parent)

| API                            | First request of the job                                         | Fresh   | Cached |
| ------------------------------ | ---------------------------------------------------------------- | ------- | ------ |
| completions (local)            | fork                                                             | ~245    | 11.9k  |
| completions                    | new conversation + brief                                         | ~2,520  | 0      |
| responses (production gateway) | fork, Pi default                                                 | ~12,150 | 0      |
| responses                      | fork with the parent's `pi.provider` sessionId written in `init` | ~245    | 11.9k  |
| responses                      | new conversation + brief                                         | ~2,520  | 0      |

openai-responses keys the cache by the conversation's session ID; Pi gives a fork a fresh one (`ProviderDoc.fork: "initial"`), so a plain fork misses the whole prefix there. Sharing the ID is possible through public API but reverses Pi's documented default; its effect on two concurrent conversations is unverified.

### 5. Mechanism only: scripted model, 9 runs per point

`mech-bench/bench.mjs`: same 3 tool calls plus answer for every mechanism, 14.2k-char system prompt, ≈800-char history turns; cached prefix charged at 10% of fresh. All ranges were zero.

| History   | Mechanism                                        | Prompt per job | Fresh (cache miss) | Cost-equivalent |
| --------- | ------------------------------------------------ | -------------- | ------------------ | --------------- |
| 10 turns  | main or fork                                     | 25k tok        | 2.2k chars         | 12k chars       |
| 10 turns  | new + brief                                      | 16k tok        | 17k                | 22k             |
| 50 turns  | main or fork                                     | 64k tok        | 2.2k               | 27k             |
| 50 turns  | new + brief                                      | 16k tok        | 17k                | 22k             |
| 200 turns | main or fork                                     | 209k tok       | 2.2k               | 85k             |
| 200 turns | new + brief                                      | 16k tok        | 17k                | 22k             |
| 200 turns | fork, cache missed (responses API, no shared ID) | 209k tok       | 209k               | 272k            |

A new conversation costs the same whatever the parent's length; fork costs what the parent costs and grows with it. Break-even is about 35 history turns, about 11k tokens per request; the local DM main after one afternoon was already at 14k.

### 6. Things checked and found fine

- The DM write-back carries the task's actual result (read from `sessions.db`); the "請查看上方結果" line is the Slack thread notice. Asked afterwards, the DM main answered 5/5 correctly with 0–600 extra tokens.
- Subagent briefs kept the request's constraints in every inspected case.

### 7. Context isolation, the remaining reason for subagents

The tool was introduced to keep the parent's context small, to finish faster and more completely in parallel, and to run in the background. Experiments 1–3 cover the second; the third never applied, because the parent waits inside the tool call. For the first:

- Production subagent results, 28 days (read-only; children ran in memory, so only the tool result's `details` survive): 187 calls, children read a median ~56k tokens and returned ~190; 44% ended without an answer (40 on a profile token cap, 37 on the 10-minute timeout).
- Production runs without a subagent, same window: the parent's context grew a median 0 tokens per run (p90 18.8k, p99 67k; 2.7% grew past 40k). A parent doing the work itself reads far less than a child that starts without context, so an estimate that assumes equal work overstates the saving.
- Lab, branch with a single-task subagent (no profiles, batches, budget, or timeout): six 24 KB incident reports in a channel, then three follow-ups, 2 reps. Done directly, the parent grepped the facts: $0.029–0.049 in total, follow-up prompts 38–42k. Told to use a subagent: $0.063–0.068, follow-up prompts 40–43k (no smaller), one follow-up wrong.
- The same single-task branch on the earlier cases: the model delegated the three-repository task in 3 of 3 runs (all correct, $0.067–0.100, against $0.03–0.05 direct) and once called three subagents one per turn on the 90-second waits (300 s).

## Findings

| #   | Claim                                                                                                                                                                              | Evidence         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | Delegation does not make a complex task faster; the sandbox has one CPU and Pi already runs a turn's tool calls in parallel.                                                       | Experiments 1–3  |
| 2   | Parallel subagents on CPU-bound work are worse on all three goals and can OOM.                                                                                                     | Experiments 1–2  |
| 3   | Delegation costs one extra system-prompt miss (~2.5k tokens) plus whatever the parent spends dispatching; in the DM that is paid by default for every multi-step request.          | Experiments 1, 4 |
| 4   | "New conversation plus a brief" is the cheapest mechanism once the parent exceeds ~11k tokens, which real DMs do. Fork wins only on first-request latency and on carrying context. | Experiment 5     |
| 5   | Fork on production's API needs the parent's session ID to hit the cache at all.                                                                                                    | Experiment 4     |
| 6   | Prompt facts about parallelism and sandbox size did not change the model's choices.                                                                                                | Experiment 3     |
| 7   | Context isolation does not pay in mikan: a parent working directly reads little, and a subagent cost about twice as much without shrinking later prompts.                          | Experiment 7     |

Earlier claims withdrawn: "DM is 1.8× slower than channel" compared two offices; "fork is cheaper" looked at fresh tokens only; "briefs lose constraints" and "the write-back content is wrong" were not reproduced.

## Open questions

- What the DM `start_task` default buys: the only measured benefit is that the top level stays free to chat. Whether that is worth +50% per multi-step request is a product decision.
- Whether the sandbox should offer more CPU to parallel work (boost exists as a command, not as a policy).
