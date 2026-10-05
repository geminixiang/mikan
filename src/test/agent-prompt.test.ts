import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendTriggerAttribution,
  buildSystemPrompt,
  buildTurnInstructions,
  resolveTriggerAttribution,
} from "../harness/prompt.js";
import { normalizeAttachRuntimePath } from "../harness/tools/attach.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { resolveWorkspaceProjection } from "../office/projection.js";
import { createGlobalSettingsFile } from "../settings/index.js";

const PLATFORM = {
  name: "slack",
  formattingGuide: "",
  channels: [],
  users: [],
};

describe("trigger attribution", () => {
  test("uses event filename from event prompt marker", () => {
    expect(
      resolveTriggerAttribution({
        id: "123.456",
        text: "[EVENT:daily-summary.json:periodic:2026-05-19T00:00:00Z] summarize",
      }),
    ).toBe("[event: daily-summary.json]");
  });

  test("uses synthetic event id when prompt has no event marker", () => {
    expect(
      resolveTriggerAttribution({
        id: "event:daily-summary",
        text: "Handle the following recurring task.",
      }),
    ).toBe("[event: daily-summary]");
  });

  test("uses user name for normal user-triggered messages", () => {
    expect(resolveTriggerAttribution({ id: "123.456", text: "hello", userName: "david" })).toBe(
      "@david",
    );
  });

  test("omits attribution when no trigger identity is available", () => {
    expect(resolveTriggerAttribution({ id: "123.456", text: "hello" })).toBeUndefined();
  });
});

describe("append trigger attribution", () => {
  test("appends attribution to final chat response", () => {
    expect(appendTriggerAttribution("Done.", "@david")).toBe("Done.\n\n_Triggered by @david_");
  });

  test("does not duplicate existing attribution", () => {
    expect(appendTriggerAttribution("Done.\n\n_Triggered by @david_", "@david")).toBe(
      "Done.\n\n_Triggered by @david_",
    );
  });

  test("leaves text unchanged without attribution", () => {
    expect(appendTriggerAttribution("Done.", undefined)).toBe("Done.");
  });

  test("does not duplicate when attribution contains underscores", () => {
    const already = "Done.\n\n_Triggered by [event: foo_bar.json]_";
    expect(appendTriggerAttribution(already, "[event: foo_bar.json]")).toBe(already);
  });

  test("adds session link outside the italic span (Slack italics can't span URLs)", () => {
    expect(appendTriggerAttribution("Done.", "[event: daily]", "https://mikan/session?t=1")).toBe(
      "Done.\n\n_Triggered by [event: daily]_ · session: https://mikan/session?t=1",
    );
  });

  test("replaces a signature the model copied for someone else instead of stacking two", () => {
    expect(appendTriggerAttribution("Done.\n\n_Triggered by @alice_", "@bob")).toBe(
      "Done.\n\n_Triggered by @bob_",
    );
  });

  test("replaces a garbled, unclosed signature line the model wrote from habit", () => {
    expect(appendTriggerAttribution("R5A-OK  \n_Triggered by @f416720ությանը", "@f416720001")).toBe(
      "R5A-OK\n\n_Triggered by @f416720001_",
    );
  });

  test("keeps a sentence that merely mentions the phrase mid-line", () => {
    expect(appendTriggerAttribution("The job was Triggered by cron.", "@bob")).toBe(
      "The job was Triggered by cron.\n\n_Triggered by @bob_",
    );
  });

  test("upgrades existing event attribution with session link", () => {
    expect(
      appendTriggerAttribution(
        "Done.\n\n_Triggered by [event: daily]_",
        "[event: daily]",
        "https://mikan/session?t=1",
      ),
    ).toBe("Done.\n\n_Triggered by [event: daily]_ · session: https://mikan/session?t=1");
  });
});

describe("turn instructions", () => {
  test("empty for a plain interactive turn, so the user's message carries no instruction prefix", () => {
    expect(buildTurnInstructions(false)).toBe("");
  });

  test("includes event-trigger mode for event runs", () => {
    const result = buildTurnInstructions(true);
    expect(result).toContain("## Event Trigger Mode");
    expect(result).not.toContain("Triggered by");
  });
});

describe("attach path validation", () => {
  test("resolves relative attach paths from the runtime workspace", () => {
    expect(normalizeAttachRuntimePath("gpt-5-mini.md", "/workspace")).toBe(
      "/workspace/gpt-5-mini.md",
    );
  });

  test("keeps absolute attach paths inside the runtime workspace", () => {
    expect(normalizeAttachRuntimePath("/workspace/C123/report.txt", "/workspace")).toBe(
      "/workspace/C123/report.txt",
    );
  });

  test("rejects parent traversal in attach paths", () => {
    expect(() => normalizeAttachRuntimePath("../outside.txt", "/workspace")).toThrow(
      "parent-directory traversal",
    );
    expect(() =>
      normalizeAttachRuntimePath("/workspace/C123/../outside.txt", "/workspace"),
    ).toThrow("parent-directory traversal");
  });

  test("rejects absolute paths outside the runtime workspace", () => {
    expect(() => normalizeAttachRuntimePath("/etc/passwd", "/workspace")).toThrow(
      "runtime workspace",
    );
    expect(() => normalizeAttachRuntimePath("/workspace-other/file.txt", "/workspace")).toThrow(
      "runtime workspace",
    );
  });
});

describe("host sandbox environment description", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-prompt-host-env-"));
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
    createGlobalSettingsFile(stateDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("leaves chat signatures and the clock to mikan and asks for signatures only on GitHub writes", () => {
    const workspace = createWorkspace({ root: workspaceDir, stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C123"));
    const prompt = buildSystemPrompt({
      workspacePath: workspaceDir,
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "host" },
      platform: PLATFORM,
      skills: [],
      projection: resolveWorkspaceProjection(office),
    });

    expect(prompt).not.toContain("use: date");
    expect(prompt).toContain("send time");
    expect(prompt).toContain("gh pr comment");
    expect(prompt).toContain("_Triggered by @<user>_");
    expect(prompt).toMatch(/mikan (adds|appends) .*signature/i);
    expect(prompt).not.toMatch(/saluting_face/);
  });

  test("points history questions at log.jsonl, never at host-only session files", () => {
    const workspace = createWorkspace({ root: workspaceDir, stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C123"));
    const prompt = buildSystemPrompt({
      workspacePath: "/workspace",
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "image", image: "mikan-sandbox:latest" },
      platform: PLATFORM,
      skills: [],
      projection: resolveWorkspaceProjection(office),
    });

    expect(prompt).toContain("log.jsonl");
    expect(prompt).not.toMatch(/sessions\//);
  });

  test("tells the agent bash starts in the runtime workspace root, not mikan's own cwd", () => {
    const workspace = createWorkspace({ root: workspaceDir, stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C123"));
    const projection = resolveWorkspaceProjection(office);
    const prompt = buildSystemPrompt({
      workspacePath: workspaceDir,
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "host" },
      platform: PLATFORM,
      skills: [],
      projection,
    });

    expect(prompt).toContain(`Bash commands start in: ${workspaceDir}`);
    expect(prompt).not.toContain(`Bash commands start in: ${process.cwd()}`);
  });

  test("tells the agent a managed container keeps only its workspace across image updates", () => {
    const workspace = createWorkspace({ root: workspaceDir, stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C123"));
    const prompt = buildSystemPrompt({
      workspacePath: "/workspace",
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "image", image: "ubuntu:24.04" },
      platform: PLATFORM,
      skills: [],
      projection: resolveWorkspaceProjection(office),
    });

    expect(prompt).toContain("Only files under /workspace persist");
    expect(prompt).not.toContain("persist for this user's container");
  });
});

describe("system prompt memory guidance", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-prompt-memory-"));
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
    createGlobalSettingsFile(stateDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function projectionFor(
    visibility: "public" | "private",
  ): ReturnType<typeof resolveWorkspaceProjection> {
    const workspace = createWorkspace({ root: workspaceDir, stateDir });
    const office = workspace.office(createOfficeAddress("slack", "C123"));
    const base = resolveWorkspaceProjection(office);
    const { globalKnowledgeReadOnly: _ignored, ...sources } = base.promptSources;
    return {
      ...base,
      visibility,
      promptSources: {
        ...sources,
        globalMemoryPath: join(workspaceDir, "MEMORY.md"),
        globalSkillsDir: join(workspaceDir, "skills"),
        ...(visibility === "private" ? { globalKnowledgeReadOnly: true } : {}),
      },
    };
  }

  test("lists only the channels this office can read", () => {
    const projection = { ...projectionFor("private"), readableConversationIds: ["C123", "C200"] };
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt({
      workspacePath: workspaceDir,
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "container", container: "c1" },
      platform: {
        ...PLATFORM,
        channels: [
          { id: "C123", name: "here" },
          { id: "C200", name: "general" },
          { id: "G300", name: "secret-plans" },
          { id: "D400", name: "DM:alice" },
        ],
      },
      skills: [],
      projection,
    });

    expect(prompt).toContain("C123\t#here");
    expect(prompt).toContain("C200\t#general");
    expect(prompt).not.toContain("secret-plans");
    expect(prompt).not.toContain("DM:alice");
  });

  test("public visibility tells the agent it can write shared memory", () => {
    const projection = projectionFor("public");
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt({
      workspacePath: workspaceDir,
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "container", container: "c1" },
      platform: PLATFORM,
      skills: [],
      projection,
    });

    expect(prompt).toContain("Write important shared knowledge to");
    expect(prompt).not.toContain("mounted read-only");
  });

  test("private visibility tells the agent shared memory is read-only", () => {
    const projection = projectionFor("private");
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt({
      workspacePath: workspaceDir,
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "container", container: "c1" },
      platform: PLATFORM,
      skills: [],
      projection,
    });

    expect(prompt).toContain("mounted read-only for this private office");
    expect(prompt).toContain("writes to it are rejected");
    expect(prompt).toContain("it never leaves this conversation");
  });

  test("treats memory as a revisable anchor below newer and Live evidence", () => {
    const projection = projectionFor("public");
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt({
      workspacePath: workspaceDir,
      office,
      memory: "(no memory)",
      sandboxConfig: { type: "container", container: "c1" },
      platform: PLATFORM,
      skills: [],
      projection,
    });

    expect(prompt).toContain("compact, revisable orientation anchor");
    expect(prompt).toContain("transcript or final truth");
    expect(prompt).toContain("prefer the newer evidence");
    expect(prompt).toContain("query the Live source or current API in this run");
    expect(prompt).toContain("prefer that fresh result over memory or older API observations");
    expect(prompt).toContain("current state could not be verified");
    expect(prompt).toContain("do not fall back to memory as current truth");
    expect(prompt).toContain("normal, expected requests");
  });
});
