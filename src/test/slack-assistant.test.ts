import { describe, expect, test } from "vitest";
import {
  AssistantThreadRegistry,
  handleAgentContextChanged,
  handleAgentDmOpened,
  handleAssistantThreadStarted,
  summarizeTitle,
  titleAssistantThread,
  type AssistantSurfaceOps,
} from "../adapters/slack/assistant.js";

/**
 * The assistant surface (Slack's "AI app" pane) has a lifecycle the classic
 * app path does not: Slack expects the app to speak first, and shows past
 * conversations by title. Both events were subscribed in the manifest and
 * dropped, which is what made the pane look broken rather than quiet.
 */

function createOps(overrides: Partial<AssistantSurfaceOps> = {}) {
  const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
  const prompts: Array<{ threadTs: string | undefined; titles: string[] }> = [];
  const titles: Array<{ threadTs: string; title: string }> = [];
  const ops: AssistantSurfaceOps = {
    postInThread: async (channel, threadTs, text) => {
      posts.push({ channel, threadTs, text });
      return "1700.1";
    },
    setSuggestedPrompts: async (_channel, threadTs, list) => {
      prompts.push({ threadTs, titles: list.map((entry) => entry.title) });
    },
    setTitle: async (_channel, threadTs, title) => {
      titles.push({ threadTs, title });
    },
    channelName: () => undefined,
    ...overrides,
  };
  return { ops, posts, prompts, titles };
}

describe("assistant thread lifecycle", () => {
  test("greets and offers prompts when a conversation opens", async () => {
    const { ops, posts, prompts } = createOps();
    const registry = new AssistantThreadRegistry();

    await handleAssistantThreadStarted(ops, registry, {
      channel_id: "D1",
      thread_ts: "100.1",
      user_id: "U1",
    });

    // Slack waits for the app to speak first; silence is what reads as broken.
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: "D1", threadTs: "100.1" });
    expect(prompts[0]?.titles.length).toBeGreaterThan(0);
    expect(registry.isAgentSurface("D1", "100.1")).toBe(true);
  });

  test("names the channel the person is looking at", async () => {
    const { ops, posts, prompts } = createOps({
      channelName: (id) => (id === "C9" ? "engineering" : undefined),
    });
    const registry = new AssistantThreadRegistry();

    await handleAssistantThreadStarted(ops, registry, {
      channel_id: "D1",
      thread_ts: "100.1",
      context: { channel_id: "C9" },
    });

    // Naming the channel is the cheap half of context-awareness: no model
    // call, and it is what makes the suggestions feel addressed to the moment.
    expect(posts[0]?.text).toContain("#engineering");
    expect(prompts[0]?.titles.join(" ")).toContain("#engineering");
  });

  test("a greeting failure still leaves prompts offered", async () => {
    const { ops, prompts } = createOps({
      postInThread: async () => {
        throw new Error("channel_not_found");
      },
    });
    const registry = new AssistantThreadRegistry();

    // A pane without a greeting is worse, not broken — the handler must not
    // take the socket listener down with it.
    await expect(
      handleAssistantThreadStarted(ops, registry, { channel_id: "D1", thread_ts: "100.1" }),
    ).resolves.toBeUndefined();
    expect(prompts).toHaveLength(1);
  });

  test("context changes are remembered for the next turn", () => {
    const registry = new AssistantThreadRegistry();
    registry.remember("D1", "100.1", { channel_id: "C1" });

    handleAgentContextChanged(registry, {
      channel_id: "D1",
      thread_ts: "100.1",
      context: { channel_id: "C2" },
    });

    expect(registry.contextFor("D1", "100.1")?.channel_id).toBe("C2");
  });

  test("ignores payloads without a thread", async () => {
    const { ops, posts } = createOps();
    const registry = new AssistantThreadRegistry();
    await handleAssistantThreadStarted(ops, registry, { channel_id: "D1" });
    expect(posts).toHaveLength(0);
    expect(registry.isAgentSurface("D1", "100.1")).toBe(false);
  });
});

describe("agent_view: the app DM", () => {
  test("opening the DM pins prompts and does not greet", async () => {
    const { ops, posts, prompts } = createOps();
    const registry = new AssistantThreadRegistry();

    await handleAgentDmOpened(ops, registry, "D1", { channel_id: "C9" });

    // app_home_opened fires on EVERY open, so greeting here would nag. Only
    // the prompts refresh, which is idempotent.
    expect(posts).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    // No thread_ts: the prompts pin to the DM, because under agent_view there
    // is no thread yet when it opens.
    expect(prompts[0]?.threadTs).toBeUndefined();
    expect(registry.channelContext("D1")?.channel_id).toBe("C9");
  });

  test("a DM known as the agent surface makes its threads titleable", async () => {
    const { ops, titles } = createOps();
    const registry = new AssistantThreadRegistry();
    await handleAgentDmOpened(ops, registry, "D1");

    // Slack opens threads itself under agent_view and never announces them,
    // so titles have to work off the channel rather than a registered thread.
    await titleAssistantThread(ops, registry, "D1", "100.1", "看一下昨天的部署");
    expect(titles).toEqual([{ threadTs: "100.1", title: "看一下昨天的部署" }]);
  });

  test("app_context_changed without a thread updates the channel", () => {
    const registry = new AssistantThreadRegistry();
    handleAgentContextChanged(registry, { channel_id: "D1", context: { channel_id: "C5" } });
    expect(registry.channelContext("D1")?.channel_id).toBe("C5");
    expect(registry.isAgentSurface("D1", "any.thread")).toBe(true);
  });
});

describe("assistant thread titles", () => {
  test("titles an assistant thread once, from the first message", async () => {
    const { ops, titles } = createOps();
    const registry = new AssistantThreadRegistry();
    registry.remember("D1", "100.1");

    await titleAssistantThread(ops, registry, "D1", "100.1", "幫我看一下昨天的部署");
    await titleAssistantThread(ops, registry, "D1", "100.1", "還有今天的");

    expect(titles).toEqual([{ threadTs: "100.1", title: "幫我看一下昨天的部署" }]);
  });

  test("leaves classic DM threads alone", async () => {
    const { ops, titles } = createOps();
    const registry = new AssistantThreadRegistry();

    // Never registered by the assistant lifecycle, so it is an ordinary thread
    // in a DM and Slack has no conversation list to label.
    await titleAssistantThread(ops, registry, "D1", "100.1", "hello");
    expect(titles).toHaveLength(0);
  });

  test("a title failure is swallowed", async () => {
    const { ops } = createOps({
      setTitle: async () => {
        throw new Error("ratelimited");
      },
    });
    const registry = new AssistantThreadRegistry();
    registry.remember("D1", "100.1");
    await expect(titleAssistantThread(ops, registry, "D1", "100.1", "hi")).resolves.toBeUndefined();
  });
});

describe("summarizeTitle", () => {
  test("takes the first non-empty line and strips mentions", () => {
    expect(summarizeTitle("<@U123> 部署狀況如何？\n細節在下面")).toBe("部署狀況如何？");
  });

  test("truncates long messages", () => {
    const title = summarizeTitle("x".repeat(80));
    expect(title).toHaveLength(50);
    expect(title.endsWith("…")).toBe(true);
  });

  test("returns empty for a message with nothing in it", () => {
    expect(summarizeTitle("   \n  ")).toBe("");
    expect(summarizeTitle("<@U123>")).toBe("");
  });
});
