import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../adapter.js";
import { createSlackToolPack } from "../adapters/slack/tool-pack.js";
import { createRunner } from "../agent.js";
import { loadSkillsFromDir } from "../harness/skills.js";
import { MikanAgentSession, MikanModels } from "../harness/index.js";
import { officeSessionsDir } from "../office/index.js";
import { createManagedSessionFile } from "../sessions/store.js";
import type { PlatformToolPackFactory } from "../tools/types.js";
import { createOfficeAddress, createWorkspace, type Office } from "../office/index.js";

/**
 * Drives PiAgentWrapper.run() end to end with a faux provider: the runner is
 * built by the real createRunner (host sandbox, no vault/provisioner) and the
 * scripted responder observes the run-lifecycle behaviour that previously had
 * no test through this interface — final replacement, [SILENT], error
 * finalize, and run-state reset between runs.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-agent-runner-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
  process.env.MIKAN_STATE_DIR = stateDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MIKAN_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const C1_ADDRESS = createOfficeAddress("slack", "C1");

/** The office every test in this file drives, rooted in the per-test tmpdir. */
function testOffice(): Office {
  return createWorkspace({ root: join(dir, "workspace"), stateDir: join(dir, "state") }).office(
    C1_ADDRESS,
  );
}

function createFauxModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({ faux: { type: "api_key", key: "test-key" } }));
  const models = MikanModels.create({
    authPath,
    modelsJsonPath: join(dir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

async function createTestRunner(
  platformToolPackFactories: readonly PlatformToolPackFactory[] = [],
) {
  const { models, faux } = createFauxModels();
  const office = testOffice();
  const conversationDir = office.ensure();
  const sessionDir = officeSessionsDir(conversationDir);
  const contextFile = createManagedSessionFile(sessionDir, conversationDir);

  const runner = await createRunner({
    sandboxConfig: { type: "host" },
    sessionKey: "C1",
    office,
    sessionScope: { sessionDir, contextFile, threadRootMessage: null },
    models,
    platformToolPackFactories,
  });
  return { runner, faux };
}

function makeResponder(): ConversationResponder & {
  respond: ReturnType<typeof vi.fn>;
  replaceResponse: ReturnType<typeof vi.fn>;
  replaceSubagentProgress: ReturnType<typeof vi.fn>;
  respondDiagnostic: ReturnType<typeof vi.fn>;
  deleteResponse: ReturnType<typeof vi.fn>;
} {
  return {
    respond: vi.fn().mockResolvedValue(undefined),
    replaceResponse: vi.fn().mockResolvedValue(undefined),
    replaceSubagentProgress: vi.fn().mockResolvedValue(undefined),
    respondDiagnostic: vi.fn().mockResolvedValue(undefined),
    respondToolResult: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    setWorking: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue(undefined),
    deleteResponse: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    address: createOfficeAddress("slack", "C1"),
    id: "1000.1",
    sessionKey: "C1",
    conversationKind: "shared",
    userId: "U1",
    userName: "alice",
    text: "hi",
    attachments: [],
    ...overrides,
  };
}

const platform: MessagingInfo = {
  name: "chat",
  formattingGuide: "",
  channels: [],
  users: [],
  trustModel: "membership",
};

describe("PiAgentWrapper.run", () => {
  test("does not follow conversation memory symlinks during host prompt construction", async () => {
    const outside = join(dir, "outside-secret.txt");
    writeFileSync(outside, "DO_NOT_LEAK_THIS_SECRET");
    const office = testOffice();
    const memoryPath = office.memoryPath;
    office.ensure();
    rmSync(memoryPath, { force: true });
    symlinkSync(outside, memoryPath);
    const { runner } = await createTestRunner();
    await runner.dispose();

    expect(readFileSync(outside, "utf-8")).toBe("DO_NOT_LEAK_THIS_SECRET");
  });

  test("skips symlinked conversation skill entries without loading them", async () => {
    const outside = join(dir, "outside-skill.md");
    writeFileSync(outside, "---\nname: escaped\ndescription: secret\n---\nDO_NOT_LOAD");
    const skillsDir = join(dir, "workspace", "C1", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(outside, join(skillsDir, "escaped.md"));

    const result = loadSkillsFromDir({ dir: skillsDir, source: "channel", rejectSymlinks: true });

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "symlink", path: join(skillsDir, "escaped.md") }),
    ]);
  });

  test("surfaces subagent batch progress through the platform-neutral responder", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subagent", {
          tasks: [
            { label: "first", task: "first task", profile: "analysis-only" },
            { label: "second", task: "second task", profile: "analysis-only" },
          ],
        }),
      ),
      fauxAssistantMessage("first result"),
      fauxAssistantMessage("second result"),
      fauxAssistantMessage("parent complete"),
    ]);
    const responder = makeResponder();

    await runner.run(makeMessage({ text: "delegate twice" }), responder, platform);

    expect(responder.replaceSubagentProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "parallel",
        nodes: [
          expect.objectContaining({ id: "0", label: "first", status: "completed" }),
          expect.objectContaining({ id: "1", label: "second", status: "completed" }),
        ],
      }),
      expect.stringContaining("parent complete"),
    );
    // toContain compares by equality and never evaluates an asymmetric
    // matcher, so the substring check has to be toContainEqual.
    const replacements = responder.replaceResponse.mock.calls.map((call) => String(call[0]));
    expect(replacements).not.toContainEqual(expect.stringContaining("Subagent parallel"));
    expect(responder.replaceSubagentProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ turns: 1, toolCalls: 0, tokens: expect.any(Number) }),
        ]),
      }),
      expect.stringContaining("parent complete"),
    );
    expect(responder.replaceSubagentProgress.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test("composes the Markdown dashboard through replaceResponse without an override", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subagent", {
          tasks: [
            { label: "first", task: "first task", profile: "analysis-only" },
            { label: "second", task: "second task", profile: "analysis-only" },
          ],
        }),
      ),
      fauxAssistantMessage("first result"),
      fauxAssistantMessage("second result"),
      fauxAssistantMessage("parent complete"),
    ]);
    const responder = makeResponder() as ConversationResponder & {
      respond: ReturnType<typeof vi.fn>;
      replaceResponse: ReturnType<typeof vi.fn>;
    };
    delete responder.replaceSubagentProgress;

    await runner.run(makeMessage({ text: "delegate twice" }), responder, platform);

    // "dashboard, blank line, answer" — composed by the harness, converted by
    // the platform like any response.
    const finalReplacement = String(responder.replaceResponse.mock.calls.at(-1)?.[0]);
    expect(finalReplacement).toContain("**Subagents · 2/2 · Parallel");
    expect(finalReplacement).toContain("✓ first");
    expect(finalReplacement).toContain("\n\nparent complete");
    expect(finalReplacement.indexOf("**Subagents")).toBeLessThan(
      finalReplacement.indexOf("parent complete"),
    );
    // The intermediate finish is skipped: nothing may overwrite the dashboard
    // with the bare answer before the final composition.
    const bareResponds = responder.respond.mock.calls.map((call) => String(call[0]));
    expect(bareResponds).not.toContain("parent complete");
  });

  test("replaces the placeholder with the final assistant text", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([fauxAssistantMessage("hello from the agent")]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(responder.replaceResponse).toHaveBeenCalledTimes(1);
    expect(responder.replaceResponse.mock.calls[0]?.[0]).toContain("hello from the agent");
    expect(responder.deleteResponse).not.toHaveBeenCalled();
    expect(runner.getCurrentStep()).toBeUndefined();
  });

  test("uploads a workspace file through the executor's regular base64 reader", async () => {
    const { runner, faux } = await createTestRunner();
    const scratchDir = join(dir, "workspace", "C1", "scratch");
    const reportPath = join(scratchDir, "report.html");
    mkdirSync(scratchDir, { recursive: true });
    writeFileSync(reportPath, "<h1>Report</h1>");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("attach", {
          label: "share report",
          path: reportPath,
          title: "report.html",
        }),
      ),
      fauxAssistantMessage("attached"),
    ]);
    let uploadedContent: string | undefined;
    const responder = makeResponder();
    responder.uploadFile = vi.fn(async (stagedPath: string) => {
      uploadedContent = readFileSync(stagedPath, "utf-8");
    });

    const result = await runner.run(
      makeMessage({ text: "attach the report" }),
      responder,
      platform,
    );

    expect(result.stopReason).toBe("stop");
    expect(responder.uploadFile).toHaveBeenCalledWith(expect.any(String), "report.html");
    expect(uploadedContent).toBe("<h1>Report</h1>");
  });

  test("[SILENT] responses delete the placeholder instead of replacing it", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([fauxAssistantMessage("[SILENT]")]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("stop");
    expect(responder.deleteResponse).toHaveBeenCalledTimes(1);
    expect(responder.replaceResponse).not.toHaveBeenCalled();
  });

  test("error stop reasons surface an apology and a diagnostic", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }),
    ]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("provider exploded");
    expect(responder.replaceResponse).toHaveBeenCalledWith("_Sorry, something went wrong_");
    expect(responder.respondDiagnostic).toHaveBeenCalledWith(
      expect.stringContaining("provider exploded"),
      { style: "error" },
    );
  });

  test("run state resets between runs on the same runner", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "first run failed" }),
      fauxAssistantMessage("second run ok"),
    ]);

    const first = await runner.run(makeMessage({ id: "1000.1" }), makeResponder(), platform);
    expect(first.stopReason).toBe("error");

    const secondResponder = makeResponder();
    const second = await runner.run(makeMessage({ id: "1000.2" }), secondResponder, platform);

    expect(second.stopReason).toBe("stop");
    expect(second.errorMessage).toBeUndefined();
    expect(secondResponder.replaceResponse.mock.calls[0]?.[0]).toContain("second run ok");
    expect(secondResponder.respondDiagnostic).not.toHaveBeenCalled();
  });

  test("hidden session Dream sees the old transcript and writes memory", async () => {
    const promptSpy = vi.spyOn(MikanAgentSession.prototype, "prompt");
    const { runner, faux } = await createTestRunner();
    const memoryPath = testOffice().memoryPath;
    const setupResponder = makeResponder();
    let maintenancePrompt = "";
    faux.setResponses([
      fauxAssistantMessage("recorded old turn"),
      (context) => {
        const messages = JSON.stringify(context.messages);
        expect(messages).toContain("durable launch decision");
        maintenancePrompt = messages;
        return fauxAssistantMessage(
          fauxToolCall("write", {
            label: "preserve memory",
            path: memoryPath,
            content: "Launch decision: use the staged rollout.",
          }),
        );
      },
      fauxAssistantMessage("memory updated"),
    ]);
    await runner.run(
      makeMessage({ text: "durable launch decision: use a staged rollout" }),
      setupResponder,
      platform,
    );
    const visibleCallsBeforeMaintenance = setupResponder.replaceResponse.mock.calls.length;

    const result = await runner.dreamSessionMemory(
      makeMessage({ id: "memory:C1", conversationKind: "direct", text: "/new" }),
      platform,
    );

    expect(result).toEqual({ stopReason: "stop", errorMessage: undefined });
    expect(maintenancePrompt).toContain("preserve only durable information");
    expect(maintenancePrompt).toContain("update only the conversation-specific MEMORY.md");
    expect(maintenancePrompt).toContain("Do not modify the workspace-level global MEMORY.md");
    expect(maintenancePrompt).toContain("Preserve the concrete values and details needed");
    expect(maintenancePrompt).toContain("exact content is worth preserving");
    // The transcript this run reads was written while the agent held its full
    // tool set, so the narrowed grant has to be stated or the model calls a
    // tool it no longer holds and spends a turn on the failure.
    expect(maintenancePrompt).toContain("Your tools this run: read, edit, write.");
    expect(maintenancePrompt).toContain("including tools used earlier in this transcript");
    expect(maintenancePrompt).not.toContain("bash");
    expect(promptSpy.mock.calls.at(-1)?.[1]).toMatchObject({
      budget: { maxDurationMs: 120_000, maxLlmCalls: 10 },
    });
    expect(setupResponder.replaceResponse).toHaveBeenCalledTimes(visibleCallsBeforeMaintenance);
    expect(readFileSync(memoryPath, "utf-8")).toBe("Launch decision: use the staged rollout.");
  });

  test("session Dream cannot write global memory", async () => {
    const { runner, faux } = await createTestRunner();
    const globalMemoryPath = join(dir, "workspace", "MEMORY.md");
    writeFileSync(globalMemoryPath, "global stays unchanged");
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", {
          label: "incorrectly promote memory",
          path: globalMemoryPath,
          content: "should not be written",
        }),
      ),
      fauxAssistantMessage("could not update global memory"),
    ]);

    await runner.dreamSessionMemory(
      makeMessage({ id: "memory:C1", conversationKind: "direct", text: "/new" }),
      platform,
    );

    expect(readFileSync(globalMemoryPath, "utf-8")).toBe("global stays unchanged");
  });

  test("a successful Slack Block Kit call owns the final visible response", async () => {
    const postBlocks = vi.fn(async () => ({ ts: "block-message" }));
    const { runner, faux } = await createTestRunner([
      () =>
        createSlackToolPack({
          postBlocks,
          updateBlocks: vi.fn(async () => {}),
        }),
    ]);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("slack_blockkit", {
          blocks: [{ type: "section", text: { type: "mrkdwn", text: "Choose" } }],
          text: "Choose",
        }),
      ),
      fauxAssistantMessage("This text must not be posted after the interactive message."),
    ]);
    const responder = makeResponder();

    await runner.run(makeMessage(), responder, { ...platform, name: "slack" });

    expect(postBlocks).toHaveBeenCalledOnce();
    const visibleText = [
      ...responder.respond.mock.calls,
      ...responder.replaceResponse.mock.calls,
    ].flatMap((call) => call.map(String));
    expect(visibleText.join("\n")).not.toContain("This text must not be posted");
  });

  test("empty final text leaves the placeholder untouched", async () => {
    const { runner, faux } = await createTestRunner();
    faux.setResponses([fauxAssistantMessage("")]);
    const responder = makeResponder();

    const result = await runner.run(makeMessage(), responder, platform);

    expect(result.stopReason).toBe("stop");
    expect(responder.replaceResponse).not.toHaveBeenCalled();
    expect(responder.deleteResponse).not.toHaveBeenCalled();
  });
});
