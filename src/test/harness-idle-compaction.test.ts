import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  type Api,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import type { HarnessEvent } from "../harness/types.js";
import { SessionStore } from "../sessions/session-store.js";

const CONTEXT_WINDOW = 10_000;
const PROMPT_CHARS = 9_500;
const COMPACTION = { enabled: true, reserveTokens: 2_000, keepRecentTokens: 500 };

let dir: string;
const stores: SessionStore[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-idle-compaction-"));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  const faux = fauxProvider({ models: [{ id: "faux-small", contextWindow: CONTEXT_WINDOW }] });
  (models.models as MutableModels).setProvider(faux.provider);
  const store = await SessionStore.create(join(dir, "session.jsonl"), dir);
  stores.push(store);
  const session = new MikanAgentSession({
    model: faux.getModel() as Model<Api>,
    models,
    sessionStore: store,
    tools: [],
    thinkingLevel: "off",
    systemPrompt: "prompt",
    settings: { compaction: COMPACTION },
  });
  return { faux, store, session };
}

async function compactionEntries(store: SessionStore) {
  return (await store.getEntries()).filter((entry) => entry.type === "compaction");
}

test("compacts between prompts once context nears Pi's automatic threshold", async () => {
  const { faux, store, session } = await setup();
  const summaries: string[] = [];
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage("second answer"),
    (context) => {
      summaries.push(JSON.stringify(context.messages));
      return fauxAssistantMessage("summary of earlier work");
    },
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("summary of earlier work");
      return fauxAssistantMessage("third answer");
    },
  ]);
  await session.prompt(`first ${"a".repeat(PROMPT_CHARS)}`);
  await session.prompt(`second ${"b".repeat(PROMPT_CHARS)}`);
  expect(await compactionEntries(store)).toHaveLength(0);

  session.compactWhenNearLimit();
  const events: HarnessEvent[] = [];
  session.subscribe((event) => {
    events.push(event);
  });
  await session.prompt("third");

  expect(summaries).toHaveLength(1);
  expect(await compactionEntries(store)).toHaveLength(1);
  expect(faux.state.callCount).toBe(4);
  expect(events.find((event) => event.type === "agent_end")).toBeDefined();
});

test("leaves short conversations alone", async () => {
  const { faux, store, session } = await setup();
  faux.setResponses([fauxAssistantMessage("short answer")]);
  await session.prompt("hello");

  session.compactWhenNearLimit();
  await session.cancelIdleCompaction();

  expect(faux.state.callCount).toBe(1);
  expect(await compactionEntries(store)).toHaveLength(0);
});

test("cancelling an in-flight idle compaction settles without writing a summary", async () => {
  const { faux, store, session } = await setup();
  let summaryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    summaryStarted = resolve;
  });
  faux.setResponses([
    fauxAssistantMessage("first answer"),
    fauxAssistantMessage("second answer"),
    (_context, options) =>
      new Promise((resolve) => {
        summaryStarted();
        options?.signal?.addEventListener("abort", () =>
          resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
        );
      }),
  ]);
  await session.prompt(`first ${"a".repeat(PROMPT_CHARS)}`);
  await session.prompt(`second ${"b".repeat(PROMPT_CHARS)}`);

  session.compactWhenNearLimit();
  await started;
  await session.cancelIdleCompaction();

  expect(await compactionEntries(store)).toHaveLength(0);
});
