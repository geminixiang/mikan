import type { KnownBlock } from "@slack/types";
import { PRODUCT_NAME } from "../../platform-messages.js";
import type { PeriodicEventInfo, RunningSession } from "../../types.js";
import type { SlackChannel } from "./types.js";

/** Threshold for "stuck" detection in the Home tab's running-tasks list. */
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

export interface BuildHomeViewDeps {
  getRunningSessions: () => RunningSession[];
  channels: Map<string, SlackChannel>;
  getPeriodicEvents: () => PeriodicEventInfo[];
}

export function buildHomeView(deps: BuildHomeViewDeps): { type: "home"; blocks: KnownBlock[] } {
  const blocks: object[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${PRODUCT_NAME}*\nStart a new task or check on running work.`,
      },
      accessory: {
        type: "image",
        image_url: "https://media1.tenor.com/m/lfDATg4Bhc0AAAAC/happy-cat.gif",
        alt_text: PRODUCT_NAME,
      },
    },
  ];

  // --- Running tasks ---
  const runningSessions = deps.getRunningSessions();

  blocks.push(
    { type: "divider" },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Running Tasks (${runningSessions.length})`,
        emoji: true,
      },
    },
  );

  if (runningSessions.length === 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_No tasks running right now._" }],
    });
  } else {
    for (const session of runningSessions) {
      const channelId = session.sessionKey.split(":")[0];
      const channel = deps.channels.get(channelId);
      const channelName = channel ? `#${channel.name}` : channelId;
      const elapsed = Math.floor((Date.now() - session.startedAt) / 60000);
      const elapsedStr = elapsed < 1 ? "<1 min" : `${elapsed} min`;

      // Check if task might be stuck
      const lastActivity = session.lastActivityAt ? Date.now() - session.lastActivityAt : 0;
      const isStuck = lastActivity > STUCK_THRESHOLD_MS;
      const statusText = isStuck ? "_stuck_" : "_running_";

      // Build status line: channel · status · time · step
      let statusLine = `${statusText} · ${elapsedStr}`;
      if (session.currentTool) {
        statusLine += ` · ${session.currentTool}`;
      }
      if (isStuck && lastActivity > 0) {
        const inactiveMin = Math.floor(lastActivity / 60000);
        statusLine += ` · idle ${inactiveMin}m`;
      }

      // Use context block for gray small text (like "No scheduled jobs.")
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `*${channelName}* · ${statusLine}`,
          },
        ],
      });

      // Add Force Stop button as separate element if stuck
      if (isStuck) {
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: " ",
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Force Stop", emoji: true },
              action_id: `force_stop_${session.sessionKey.replace(/:/g, "_")}`,
              style: "danger",
            },
          ],
        });
      }
    }
  }

  // --- Cron jobs ---
  const periodicEvents = deps.getPeriodicEvents();

  blocks.push(
    { type: "divider" },
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Scheduled Jobs (${periodicEvents.length})`,
        emoji: true,
      },
    },
  );

  if (periodicEvents.length === 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "_No scheduled jobs._" }],
    });
  } else {
    for (const ev of periodicEvents) {
      const channelLabel =
        ev.platform === "slack"
          ? (() => {
              const channel = deps.channels.get(ev.conversationId);
              const channelName = channel ? `#${channel.name}` : ev.conversationId;
              return `${ev.platform}:${channelName}`;
            })()
          : `${ev.platform}:${ev.conversationId}`;
      const nextStr = ev.nextRun
        ? new Date(ev.nextRun).toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "—";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${ev.text}*\n└ \`${ev.schedule}\` · ${channelLabel} · Next: ${nextStr}`,
        },
      });
    }
  }

  // --- Footer ---
  blocks.push(
    { type: "divider" },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: "💡 @mention in a channel or send a DM to start a new task" },
      ],
    },
  );

  return { type: "home", blocks: blocks as KnownBlock[] };
}
