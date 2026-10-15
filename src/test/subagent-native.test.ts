import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Context, Model, MutableModels } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { SubagentSlotPool, runChildSubagent } from "../harness/subagent.js";
import { createSubagentTool } from "../harness/tools/subagent.js";
import type { SubagentProfile } from "../harness/types.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-subagent-native-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const KEY = "C123:1.000001";

function offered(context: Context | undefined): { prompt: string; tools: string[] } {
  const system = (context?.messages ?? []).flatMap((message) =>
    message.role === "system" ? [message] : [],
  );
  return {
    prompt: system.flatMap((message) => Object.values(message.sections ?? {})).join("\n"),
    tools: system.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name)),
  };
}

function setup(profile: Partial<SubagentProfile> = {}) {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  const model = faux.getModel() as Model<Api>;
  const office: Office = createWorkspace({
    root: join(dir, "workspace"),
    stateDir: join(dir, "state"),
  }).office(createOfficeAddress("slack", "C123"));
  const started: Array<() => void> = [];
  const toolStarted = () => new Promise<void>((resolve) => started.push(resolve));
  let lookups = 0;
  const lookup: AgentTool = {
    name: "lookup",
    label: "lookup",
    description: "Looks something up",
    parameters: Type.Object({}),
    execute: async () => {
      lookups += 1;
      return { content: [{ type: "text", text: "looked up" }], details: undefined };
    },
  };
  const slow: AgentTool = {
    name: "slow",
    label: "slow",
    description: "Runs until aborted",
    parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      started.shift()?.();
      await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
      return { content: [{ type: "text", text: "never" }], details: undefined };
    },
  };
  const profiles = new Map<string, SubagentProfile>([
    [
      "explorer",
      {
        name: "explorer",
        description: "Explores",
        systemPrompt: "You are the explorer profile.",
        tools: ["lookup", "slow"],
        ...profile,
      },
    ],
  ]);
  const wrap = (store: SessionStore) => {
    let session: MikanAgentSession | undefined;
    const subagent = createSubagentTool(
      async (request, hooks) =>
        runChildSubagent({
          request,
          key: hooks!.key!,
          call: hooks!.call!,
          defaultModel: model,
          models,
          availableTools: new Set(["lookup", "slow"]),
          profiles,
          slots: new SubagentSlotPool(4),
          track: (id, conversationHooks) => session!.trackSubagent(id, conversationHooks),
        }),
      profiles,
    );
    session = new MikanAgentSession({
      model,
      models,
      sessionStore: store,
      tools: [lookup, slow, subagent],
      thinkingLevel: "off",
      systemPrompt: "parent system prompt",
      settings: { compaction: { enabled: false } },
    });
    return session;
  };
  return { faux, office, toolStarted, wrap, lookups: () => lookups };
}

const delegate = fauxAssistantMessage(
  fauxToolCall("subagent", { profile: "explorer", task: "explore it" }),
  { stopReason: "toolUse" },
);

test("a subagent runs in a child conversation with only its profile's prompt and tools", async () => {
  const env = setup();
  const store = await SessionStore.open(env.office, KEY);
  let childContext: Context | undefined;
  let parentSaw = "";
  env.faux.setResponses([
    delegate,
    (context) => {
      childContext = context;
      return fauxAssistantMessage("child answer");
    },
    (context) => {
      parentSaw = JSON.stringify(context.messages);
      return fauxAssistantMessage("parent done");
    },
  ]);

  await env.wrap(store).prompt("delegate");
  await store.close();

  expect(offered(childContext).prompt).toContain("You are the explorer profile.");
  expect(offered(childContext).prompt).not.toContain("parent system prompt");
  expect(offered(childContext).tools).toEqual(["lookup", "slow"]);
  expect(offered(childContext).prompt).not.toContain("codemode");
  expect(parentSaw).toContain("child answer");
});

test("a subagent interrupted by a restart continues with its tools and answers its parent", async () => {
  const env = setup();
  const store = await SessionStore.open(env.office, KEY);
  env.faux.setResponses([
    delegate,
    fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
  ]);
  const running = env.toolStarted();
  const run = env
    .wrap(store)
    .prompt("delegate")
    .catch(() => undefined);
  await running;
  await store.close();
  await run;

  expect(await SessionStore.continueInterrupted(env.office)).toEqual([KEY]);
  const reopened = await SessionStore.open(env.office, KEY);
  let childContext: Context | undefined;
  let parentSaw = "";
  env.faux.setResponses([
    (context) => {
      childContext = context;
      return fauxAssistantMessage("child finished after restart");
    },
    (context) => {
      parentSaw = JSON.stringify(context.messages);
      return fauxAssistantMessage("parent done");
    },
  ]);
  await env.wrap(reopened).continueInterrupted();
  await reopened.close();

  expect(offered(childContext).tools).toEqual(["lookup", "slow"]);
  expect(parentSaw).toContain("child finished after restart");
});

test("a subagent over its turn budget stops before running more tools", async () => {
  const env = setup({ maxTurns: 1 });
  const store = await SessionStore.open(env.office, KEY);
  let parentSaw = "";
  env.faux.setResponses([
    delegate,
    fauxAssistantMessage(fauxToolCall("lookup", {}), { stopReason: "toolUse" }),
    (context) => {
      parentSaw = JSON.stringify(context.messages);
      return fauxAssistantMessage("parent done");
    },
  ]);

  await env.wrap(store).prompt("delegate");
  await store.close();

  expect(parentSaw).toContain("budget limit exceeded (1 LLM calls >= 1 limit)");
  expect(env.lookups()).toBe(0);
});

test("a subagent's spend counts toward its parent session", async () => {
  const env = setup();
  const store = await SessionStore.open(env.office, KEY);
  env.faux.setResponses([
    delegate,
    fauxAssistantMessage("child answer"),
    fauxAssistantMessage("parent done"),
  ]);
  const session = env.wrap(store);

  await session.prompt("delegate");
  await store.close();
  const spend = await SessionStore.spend(env.office, KEY);

  const parentOwn = session.lastRunMessages.reduce(
    (total, message) => total + (message.role === "assistant" ? message.usage.totalTokens : 0),
    0,
  );
  expect(session.getLastRunStats().llmCalls).toBe(2);
  expect(spend?.usage.totalTokens).toBeGreaterThan(parentOwn);
});
