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
import { translateAttachPathToHost } from "../harness/prompt.js";
import { getUnresolvedSandboxPathContext } from "../sandbox/registry.js";
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
  test("empty for a plain interactive turn", () => {
    expect(buildTurnInstructions(false, undefined, "slack")).toBe("");
  });

  test("includes attribution with the platform name and trigger", () => {
    const result = buildTurnInstructions(false, "@david", "slack");
    expect(result).toContain("## Attribution");
    expect(result).toContain("final slack response");
    expect(result).toContain("_Triggered by @david_");
    expect(result).not.toContain("## Event Trigger Mode");
  });

  test("includes event-trigger mode for event runs", () => {
    const result = buildTurnInstructions(true, "[event: daily]", "telegram");
    expect(result).toContain("## Event Trigger Mode");
    expect(result).toContain("## Attribution");
    expect(result).toContain("_Triggered by [event: daily]_");
  });
});

describe("runtime path context", () => {
  test("relative attach paths resolve from the runtime workspace", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(translateAttachPathToHost("gpt-5-mini.md", pathContext)).toBe(
      "/host/workspace/gpt-5-mini.md",
    );
  });

  test("absolute attach paths still translate from runtime to host", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(translateAttachPathToHost("/workspace/gpt-5-mini.md", pathContext)).toBe(
      "/host/workspace/gpt-5-mini.md",
    );
  });

  test("keeps an absolute host attach path inside the host workspace", () => {
    const pathContext = getUnresolvedSandboxPathContext({ type: "host" }, "/host/workspace");

    expect(translateAttachPathToHost("/host/workspace/report.txt", pathContext)).toBe(
      "/host/workspace/report.txt",
    );
  });

  test("rejects parent traversal in attach paths", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(() => translateAttachPathToHost("../outside.txt", pathContext)).toThrow(
      "parent-directory traversal",
    );
    expect(() => translateAttachPathToHost("/workspace/C123/../outside.txt", pathContext)).toThrow(
      "parent-directory traversal",
    );
  });

  test("rejects absolute host paths outside the runtime workspace", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(() => translateAttachPathToHost("/etc/passwd", pathContext)).toThrow(
      "runtime workspace",
    );
  });

  test("cloudflare rejects host uploads explicitly", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "cloudflare", sandboxId: "slack-u123" },
      "/host/workspace",
    );

    expect(() => translateAttachPathToHost("report.txt", pathContext)).toThrow(
      "attachments are unavailable",
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
