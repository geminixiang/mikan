import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as log from "../log.js";
import {
  conversationSettingsPath,
  createGlobalSettingsFile,
  updateConversationSettings,
  updateGlobalSettings,
} from "../config.js";
import {
  readPlatformChannelKind,
  recordPlatformChannelKind,
  resolveWorkspaceProjection,
} from "../workspace-projection/index.js";
import {
  createOfficeAddress,
  createWorkspace,
  officeKey,
  type Office,
  type Workspace,
} from "../office/index.js";

const conversationId = "C123";
const address = createOfficeAddress("slack", conversationId);
const officeSegment = officeKey(address);

describe("workspace office projection", () => {
  let stateDir: string;
  let workspaceDir: string;
  let workspace: Workspace;
  let office: Office;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-office-projection-"));
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
    createGlobalSettingsFile(stateDir);
    workspace = createWorkspace({ root: workspaceDir, stateDir });
    office = workspace.office(address);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MIKAN_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("fresh installs expose only the conversation office", () => {
    const projection = resolveWorkspaceProjection(office);

    expect(projection).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
      mounts: [
        { source: join(workspaceDir, officeSegment), target: `/workspace/${officeSegment}` },
      ],
      promptSources: {
        conversationDir: join(workspaceDir, officeSegment),
        conversationMemoryPath: join(workspaceDir, officeSegment, "MEMORY.md"),
        conversationSkillsDir: join(workspaceDir, officeSegment, "skills"),
      },
    });
    expect(projection.promptSources.globalMemoryPath).toBeUndefined();
    expect(projection.promptSources.globalSkillsDir).toBeUndefined();
    expect(existsSync(join(workspaceDir, officeSegment))).toBe(true);
    expect(existsSync(join(workspaceDir, "events"))).toBe(false);
  });

  test("maps legacy private to the trusted shared-support office", () => {
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        sandbox: { image: { workspaceMount: "private" } },
      }),
    );

    const projection = resolveWorkspaceProjection(office);

    expect(projection).toMatchObject({
      doorPolicy: "trusted",
      layout: "shared-support",
      mounts: [
        { source: join(workspaceDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
        { source: join(workspaceDir, "skills"), target: "/workspace/skills" },
        { source: join(workspaceDir, "events"), target: "/workspace/events" },
        { source: join(workspaceDir, officeSegment), target: `/workspace/${officeSegment}` },
      ],
    });
    expect(lstatSync(join(workspaceDir, "MEMORY.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspaceDir, "skills")).isDirectory()).toBe(true);
    expect(lstatSync(join(workspaceDir, "events")).isDirectory()).toBe(true);
  });

  test("maps legacy full conversation override above canonical global defaults", () => {
    const settingsPath = conversationSettingsPath(office);
    writeFileSync(settingsPath, JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }));

    expect(resolveWorkspaceProjection(office)).toMatchObject({
      doorPolicy: "trusted",
      layout: "full",
      mounts: [{ source: workspaceDir, target: "/workspace" }],
    });
  });

  test("a recorded Slack public channel shares workspace memory read-write", () => {
    recordPlatformChannelKind(office, "public_channel");

    const projection = resolveWorkspaceProjection(office);

    expect(projection).toMatchObject({
      doorPolicy: "trusted",
      layout: "shared-support",
      visibility: "public",
    });
    const memoryMount = projection.mounts.find((m) => m.target === "/workspace/MEMORY.md");
    expect(memoryMount?.readOnly).toBeUndefined();
  });

  test("a recorded Slack private channel reads shared memory without writing it", () => {
    recordPlatformChannelKind(office, "private_channel");

    const projection = resolveWorkspaceProjection(office);

    expect(projection).toMatchObject({
      doorPolicy: "trusted",
      layout: "shared-support",
      visibility: "private",
    });
    const memoryMount = projection.mounts.find((m) => m.target === "/workspace/MEMORY.md");
    expect(memoryMount?.readOnly).toBe(true);
    expect(projection.promptSources.globalMemoryReadOnly).toBe(true);
  });

  test.each(["im", "external"] as const)("a recorded %s conversation stays isolated", (kind) => {
    recordPlatformChannelKind(office, kind);

    expect(resolveWorkspaceProjection(office)).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
    });
  });

  test("an explicit admin setting wins over the platform-derived posture", () => {
    recordPlatformChannelKind(office, "public_channel");
    updateConversationSettings(office, {
      sandbox: { workspace: { doorPolicy: "isolated" } },
    });

    expect(resolveWorkspaceProjection(office)).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
    });
  });

  test("a channel kind snapshot updates in place and survives rereads", () => {
    recordPlatformChannelKind(office, "public_channel");
    expect(readPlatformChannelKind(office)).toBe("public_channel");

    recordPlatformChannelKind(office, "private_channel");
    expect(readPlatformChannelKind(office)).toBe("private_channel");

    expect(resolveWorkspaceProjection(office).visibility).toBe("private");
  });

  test("an unreadable or corrupt channel kind file falls back to isolated", () => {
    recordPlatformChannelKind(office, "public_channel");
    writeFileSync(join(office.stateDir, "channel-kind"), "banana\n");

    expect(readPlatformChannelKind(office)).toBeUndefined();
    expect(resolveWorkspaceProjection(office)).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
    });
  });

  test("warns and falls back to isolated when channel kind metadata cannot be read", () => {
    recordPlatformChannelKind(office, "public_channel");
    const channelKindPath = join(office.stateDir, "channel-kind");
    rmSync(channelKindPath);
    mkdirSync(channelKindPath);
    const warning = vi.spyOn(log, "logWarning").mockImplementation(() => {});

    expect(resolveWorkspaceProjection(office)).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
    });
    expect(warning).toHaveBeenCalledWith(
      "Could not read platform channel kind; falling back to isolated workspace",
      expect.stringContaining(channelKindPath),
    );
  });

  test("defaults shared-support to public visibility with a read-write shared MEMORY.md mount", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "shared-support" } },
    });

    const projection = resolveWorkspaceProjection(office);

    expect(projection.visibility).toBe("public");
    const memoryMount = projection.mounts.find((mount) => mount.target === "/workspace/MEMORY.md");
    expect(memoryMount?.readOnly).toBeUndefined();
    expect(projection.promptSources.globalMemoryReadOnly).toBeUndefined();
  });

  test("private visibility mounts shared MEMORY.md read-only and marks prompt sources", () => {
    updateGlobalSettings({
      sandbox: {
        workspace: { doorPolicy: "trusted", layout: "shared-support", visibility: "private" },
      },
    });

    const projection = resolveWorkspaceProjection(office);

    expect(projection.visibility).toBe("private");
    const memoryMount = projection.mounts.find((mount) => mount.target === "/workspace/MEMORY.md");
    expect(memoryMount?.readOnly).toBe(true);
    // Everything else in shared-support stays read-write; only the shared
    // memory file is gated.
    const skillsMount = projection.mounts.find((mount) => mount.target === "/workspace/skills");
    expect(skillsMount?.readOnly).toBeUndefined();
    expect(projection.promptSources.globalMemoryReadOnly).toBe(true);
  });

  test("private visibility is meaningless for full layout: still one read-write bind", () => {
    updateGlobalSettings({
      sandbox: {
        workspace: { doorPolicy: "trusted", layout: "full" },
      },
    });

    const projection = resolveWorkspaceProjection(office);

    expect(projection.mounts).toEqual([{ source: workspaceDir, target: "/workspace" }]);
    expect(projection.promptSources.globalMemoryReadOnly).toBeUndefined();
  });

  test("a conversation-scoped private override wins over a public global default", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "shared-support" } },
    });
    updateConversationSettings(office, {
      sandbox: {
        workspace: { doorPolicy: "trusted", layout: "shared-support", visibility: "private" },
      },
    });

    const projection = resolveWorkspaceProjection(office);

    expect(projection.visibility).toBe("private");
    const memoryMount = projection.mounts.find((mount) => mount.target === "/workspace/MEMORY.md");
    expect(memoryMount?.readOnly).toBe(true);
  });

  test("canonical conversation policy overrides a trusted global office", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    });
    updateConversationSettings(office, {
      sandbox: { workspace: { doorPolicy: "isolated" } },
    });

    expect(resolveWorkspaceProjection(office)).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
    });
  });

  test("recreates missing trusted support roots with their required types", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "shared-support" } },
    });

    resolveWorkspaceProjection(office);
    rmSync(join(workspaceDir, "MEMORY.md"));
    rmSync(join(workspaceDir, "skills"), { recursive: true });
    rmSync(join(workspaceDir, "events"), { recursive: true });
    resolveWorkspaceProjection(office);

    expect(lstatSync(join(workspaceDir, "MEMORY.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspaceDir, "skills")).isDirectory()).toBe(true);
    expect(lstatSync(join(workspaceDir, "events")).isDirectory()).toBe(true);
  });

  test.each([
    ["conversation symlink", (root: string) => symlinkSync(root, join(root, officeSegment))],
    ["conversation file", (root: string) => writeFileSync(join(root, officeSegment), "wrong")],
  ])("rejects a suspicious %s", (_label, arrange) => {
    arrange(workspaceDir);
    expect(() => resolveWorkspaceProjection(office)).toThrow(/regular non-symlink directory/);
  });

  test("rejects wrong-type trusted support roots", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "shared-support" } },
    });
    mkdirSync(join(workspaceDir, "MEMORY.md"));

    expect(() => resolveWorkspaceProjection(office)).toThrow(
      /workspace memory must be a regular non-symlink file/i,
    );
  });

  test("fails closed on malformed host settings", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ broken");

    expect(() => resolveWorkspaceProjection(office)).toThrow(/settings are malformed/);
  });

  test.each(["", ".", "..", "../events", "nested/id", "nested\\id", "nul\0id"])(
    "rejects unsafe conversation id %j",
    (id) => {
      // The address factory owns identity validation now, so an unsafe id can
      // never reach the projection.
      expect(() =>
        resolveWorkspaceProjection(workspace.office(createOfficeAddress("slack", id))),
      ).toThrow(/Conversation id/);
    },
  );
});
