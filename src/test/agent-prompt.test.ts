import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  appendTriggerAttribution,
  buildSystemPrompt,
  buildTurnInstructions,
  resolveTriggerAttribution,
} from "../agent/prompt.js";
import { translateAttachPathToHost } from "../agent/execution.js";
import { getUnresolvedSandboxPathContext } from "../sandbox/index.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { resolveWorkspaceProjection } from "../workspace-projection/index.js";
import { createGlobalSettingsFile } from "../config.js";

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
    // office.ensure()/resolveWorkspaceProjection materialize the shared roots;
    // build the projection object directly instead of round-tripping through
    // settings.json, since this test only cares about how buildSystemPrompt
    // renders a given projection shape.
    const base = resolveWorkspaceProjection(office);
    return {
      ...base,
      doorPolicy: "trusted",
      layout: "shared-support",
      visibility,
      promptSources: {
        ...base.promptSources,
        globalMemoryPath: join(workspaceDir, "MEMORY.md"),
        globalSkillsDir: join(workspaceDir, "skills"),
        ...(visibility === "private" ? { globalMemoryReadOnly: true } : {}),
      },
    };
  }

  test("public visibility tells the agent it can write shared memory", () => {
    const projection = projectionFor("public");
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt(
      workspaceDir,
      office,
      "shared",
      "U1",
      "(no memory)",
      { type: "container", container: "c1" },
      PLATFORM,
      [],
      projection,
    );

    expect(prompt).toContain("Write important shared knowledge to");
    expect(prompt).not.toContain("mounted read-only");
  });

  test("private visibility tells the agent shared memory is read-only", () => {
    const projection = projectionFor("private");
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt(
      workspaceDir,
      office,
      "shared",
      "U1",
      "(no memory)",
      { type: "container", container: "c1" },
      PLATFORM,
      [],
      projection,
    );

    expect(prompt).toContain("mounted read-only for this office (private visibility)");
    expect(prompt).toContain("writes to it are rejected");
    expect(prompt).toContain("it never leaves this conversation");
  });

  test("always instructs the agent that memory is curated and queryable/correctable", () => {
    const projection = projectionFor("public");
    const office = createWorkspace({ root: workspaceDir, stateDir }).office(
      createOfficeAddress("slack", "C123"),
    );
    const prompt = buildSystemPrompt(
      workspaceDir,
      office,
      "shared",
      "U1",
      "(no memory)",
      { type: "container", container: "c1" },
      PLATFORM,
      [],
      projection,
    );

    expect(prompt).toContain("curated note, not a transcript");
    expect(prompt).toContain("normal, expected requests");
  });
});
