import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import { MikanAgentSession } from "../harness/session.js";
import { MikanModels } from "../harness/models.js";
import { SessionStore } from "../sessions/session-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mikan-harness-completion-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test.each(["committed-entry delivery", "terminal listener"] as const)(
  "prompt remains active until %s completes",
  async (stage) => {
    const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
    const faux = fauxProvider();
    (models.models as MutableModels).setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("done")]);
    const store = await SessionStore.create(join(dir, "session.jsonl"), dir);
    const session = new MikanAgentSession({
      systemPrompt: "test",
      model: faux.getModel() as Model<Api>,
      thinkingLevel: "off",
      tools: [],
      models,
      sessionStore: store,
    });
    const entered = deferred();
    const release = deferred();
    let assistantPresented = false;
    let settled = false;

    if (stage === "committed-entry delivery") {
      const attach = store.createHarness.bind(store);
      vi.spyOn(store, "createHarness").mockImplementation(async (options) => {
        const harness = await attach(options);
        harness.events.on("entry_added", async (event) => {
          if (event.entry.type === "message" && event.entry.message.role === "assistant") {
            entered.resolve();
            await release.promise;
          }
        });
        return harness;
      });
    }
    session.subscribe(async (event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        assistantPresented = true;
      }
      if (stage === "terminal listener" && event.type === "agent_end") {
        entered.resolve();
        await release.promise;
      }
    });

    const run = session.prompt("hi");
    const observed = run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([entered.promise, run]);
      expect(settled).toBe(false);
      expect(session.isActiveRun).toBe(true);
      expect(assistantPresented).toBe(stage === "terminal listener");
      expect(
        (await store.getEntries()).some(
          (entry) => entry.type === "message" && entry.message.role === "assistant",
        ),
      ).toBe(true);
      await expect(session.prompt("overlapping prompt")).rejects.toThrow(
        "Agent is already processing a prompt",
      );
    } finally {
      release.resolve();
      try {
        await run;
        await observed;
      } finally {
        await store.close();
      }
    }
    expect(settled).toBe(true);
    expect(session.isActiveRun).toBe(false);
    expect(assistantPresented).toBe(true);
  },
);
