/**
 * Poll extension — the driving example for `api.blockkit`.
 *
 * `/poll 問題 | 選項A | 選項B | …` posts an interactive Block Kit message.
 * Votes are button clicks dispatched straight to `onAction` handlers: no
 * agent run, no model call — the extension counts exactly, updates the
 * message in milliseconds, and persists state in its own data dir. If a
 * poll ever needed the model (say, summarizing results), the handler would
 * call `api.triggerRun(...)` itself; whether the LLM gets involved is
 * entirely the extension's decision.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { MikanExtensionApi } from "@geminixiang/mikan";

interface PollState {
  question: string;
  options: string[];
  /** userId -> option index; re-voting overwrites, so counts stay exact. */
  votes: Record<string, number>;
  closed: boolean;
}

const MAX_OPTIONS = 10;

function tally(poll: PollState): number[] {
  const counts = poll.options.map(() => 0);
  for (const choice of Object.values(poll.votes)) {
    if (counts[choice] !== undefined) counts[choice] += 1;
  }
  return counts;
}

function renderBlocks(poll: PollState): object[] {
  const counts = tally(poll);
  const total = Object.keys(poll.votes).length;
  const lines = poll.options.map((option, i) => `${i + 1}. ${option} — ${counts[i]} 票`).join("\n");
  const status = poll.closed ? `✅ 投票已結束(共 ${total} 票)` : `共 ${total} 票`;

  const blocks: object[] = [
    { type: "markdown", text: `**${poll.question}**` },
    { type: "markdown", text: `${lines}\n\n_${status}_` },
  ];
  if (!poll.closed) {
    blocks.splice(1, 0, {
      type: "actions",
      elements: poll.options.map((option, i) => ({
        type: "button",
        text: { type: "plain_text", text: option.slice(0, 75) },
        action_id: `vote_${i}`,
        value: String(i),
      })),
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "結束投票" },
          style: "danger",
          action_id: "close",
          value: "close",
        },
      ],
    });
  }
  return blocks;
}

export default function activate(api: MikanExtensionApi) {
  const pollPath = (messageTs: string) => join(api.paths.dataDir, `poll-${messageTs}.json`);
  const loadPoll = (messageTs: string): PollState | undefined => {
    const path = pollPath(messageTs);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8")) as PollState;
  };
  const savePoll = (messageTs: string, poll: PollState) =>
    writeFileSync(pollPath(messageTs), JSON.stringify(poll, null, 2));

  api.registerCommand({
    name: "poll",
    description: "發起投票:/poll 問題 | 選項A | 選項B | …",
    handler: async (ctx) => {
      const [question, ...options] = ctx.args.split("|").map((part) => part.trim());
      if (!question || options.length < 2) {
        await ctx.respond("用法:`/poll 問題 | 選項A | 選項B | …`(至少兩個選項)");
        return;
      }
      if (options.length > MAX_OPTIONS) {
        await ctx.respond(`選項最多 ${MAX_OPTIONS} 個`);
        return;
      }
      const poll: PollState = { question, options, votes: {}, closed: false };
      const { ts } = await api.blockkit.post({
        text: `投票:${question}`,
        blocks: renderBlocks(poll),
        threadTs: ctx.threadTs,
      });
      savePoll(ts, poll);
    },
  });

  // One handler per option button; each registration is exact-match on the
  // extension's own action id (the ext:<slug>: routing prefix is invisible).
  for (let i = 0; i < MAX_OPTIONS; i++) {
    api.blockkit.onAction(`vote_${i}`, async (event) => {
      if (!event.messageTs || !event.userId) return;
      const poll = loadPoll(event.messageTs);
      if (!poll || poll.closed) return;
      poll.votes[event.userId] = i;
      savePoll(event.messageTs, poll);
      await api.blockkit.update(event.messageTs, {
        text: `投票:${poll.question}`,
        blocks: renderBlocks(poll),
      });
    });
  }

  api.blockkit.onAction("close", async (event) => {
    if (!event.messageTs) return;
    const poll = loadPoll(event.messageTs);
    if (!poll || poll.closed) return;
    poll.closed = true;
    savePoll(event.messageTs, poll);
    // Retire the buttons: further clicks have nothing to hit.
    await api.blockkit.update(event.messageTs, {
      text: `投票已結束:${poll.question}`,
      blocks: renderBlocks(poll),
    });
  });
}
