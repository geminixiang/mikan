import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import type { ConversationMessage, ConversationResponder, MessagingInfo } from "../adapter.js";
import type { McpServerConfig } from "../mcp/types.js";
import { createSlackToolPack } from "../adapters/slack/tool-pack.js";
import { createRunner } from "../agent/runner.js";
import { loadSkillsFromDir } from "../harness/skills.js";
import { MikanModels } from "../harness/index.js";
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
  delete process.env.OPENCONNECTOR_ADMIN_TOKEN;
  delete process.env.OPENCONNECTOR_ORIGIN;
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
  const models = MikanModels.create({
    modelsJsonPath: join(dir, "models.json"),
  });
  const faux = fauxProvider();
  (models.models as MutableModels).setProvider(faux.provider);
  return { models, faux };
}

async function createTestRunner(
  options: {
    trustModel?: "membership" | "open-trigger";
    mcpServers?: Record<string, McpServerConfig>;
    platformWorkspaceId?: string;
    platformToolPackFactories?: readonly PlatformToolPackFactory[];
  } = {},
) {
  const { models, faux } = createFauxModels();
  const office = testOffice();
  const conversationDir = office.ensure();
  if (options.mcpServers) {
    mkdirSync(office.stateDir, { recursive: true });
    writeFileSync(
      join(office.stateDir, "settings.json"),
      JSON.stringify({ mcpServers: options.mcpServers }),
    );
  }
  const sessionDir = officeSessionsDir(conversationDir);
  const contextFile = createManagedSessionFile(sessionDir, conversationDir);

  const runner = await createRunner({
    sandboxConfig: { type: "host" },
    sessionKey: "C1",
    office,
    trustModel: options.trustModel ?? "membership",
    platformWorkspaceId: options.platformWorkspaceId,
    sessionScope: { sessionDir, contextFile, threadRootMessage: null },
    models,
    platformToolPackFactories: options.platformToolPackFactories ?? [],
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
  test("gates configured stdio MCP commands by runner trust", async () => {
    const marker = join(dir, "mcp-launched");
    const markerScript = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "launched");`;
    const mcpServers = {
      marker: {
        command: process.execPath,
        args: ["--input-type=module", "-e", markerScript],
      },
    } satisfies Record<string, McpServerConfig>;

    const { runner: openTriggerRunner } = await createTestRunner({
      trustModel: "open-trigger",
      mcpServers,
    });
    await openTriggerRunner.dispose();
    expect(existsSync(marker)).toBe(false);

    const { runner: membershipRunner } = await createTestRunner({
      trustModel: "membership",
      mcpServers,
    });
    expect(existsSync(marker)).toBe(true);
    await membershipRunner.dispose();
  });

  test("skips OpenConnector provisioning for open-trigger runners", async () => {
    process.env.OPENCONNECTOR_ADMIN_TOKEN = "admin-secret";
    process.env.OPENCONNECTOR_ORIGIN = "http://127.0.0.1:3737";
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const { runner } = await createTestRunner({
      trustModel: "open-trigger",
      platformWorkspaceId: "T1",
      mcpServers: {
        "open-connector": {
          url: "http://127.0.0.1:3737/mcp",
          headers: { Authorization: "Bearer deployment-token" },
        },
      },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(testOffice().stateDir, "open-connector-runtime-token.json"))).toBe(
      false,
    );
    await runner.dispose();
  });

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

  test("a successful Slack Block Kit call owns the final visible response", async () => {
    const postBlocks = vi.fn(async () => ({ ts: "block-message" }));
    const { runner, faux } = await createTestRunner({
      platformToolPackFactories: [
        () =>
          createSlackToolPack({
            postBlocks,
            updateBlocks: vi.fn(async () => {}),
            ownsBlockKitMessage: () => false,
          }),
      ],
    });
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
