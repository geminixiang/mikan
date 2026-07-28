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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  conversationSettingsPath,
  createGlobalSettingsFile,
  updateConversationSettings,
  updateGlobalSettings,
} from "../src/config.js";
import { resolveWorkspaceProjection } from "../src/workspace-projection/index.js";
import { createOfficeAddress } from "../src/office-address.js";

const conversationId = "C123";
const address = createOfficeAddress("slack", conversationId);

describe("workspace office projection", () => {
  let stateDir: string;
  let workspaceDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "mikan-office-projection-"));
    workspaceDir = join(stateDir, "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    process.env.MIKAN_STATE_DIR = stateDir;
    createGlobalSettingsFile(stateDir);
  });

  afterEach(() => {
    delete process.env.MIKAN_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("fresh installs expose only the conversation office", () => {
    const projection = resolveWorkspaceProjection(workspaceDir, address);

    expect(projection).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
      mounts: [
        { source: join(workspaceDir, conversationId), target: `/workspace/${conversationId}` },
      ],
      promptSources: {
        conversationDir: join(workspaceDir, conversationId),
        conversationMemoryPath: join(workspaceDir, conversationId, "MEMORY.md"),
        conversationSkillsDir: join(workspaceDir, conversationId, "skills"),
      },
    });
    expect(projection.promptSources.globalMemoryPath).toBeUndefined();
    expect(projection.promptSources.globalSkillsDir).toBeUndefined();
    expect(existsSync(join(workspaceDir, conversationId))).toBe(true);
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

    const projection = resolveWorkspaceProjection(workspaceDir, address);

    expect(projection).toMatchObject({
      doorPolicy: "trusted",
      layout: "shared-support",
      mounts: [
        { source: join(workspaceDir, "MEMORY.md"), target: "/workspace/MEMORY.md" },
        { source: join(workspaceDir, "skills"), target: "/workspace/skills" },
        { source: join(workspaceDir, "events"), target: "/workspace/events" },
        { source: join(workspaceDir, conversationId), target: `/workspace/${conversationId}` },
      ],
    });
    expect(lstatSync(join(workspaceDir, "MEMORY.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspaceDir, "skills")).isDirectory()).toBe(true);
    expect(lstatSync(join(workspaceDir, "events")).isDirectory()).toBe(true);
  });

  test("maps legacy full conversation override above canonical global defaults", () => {
    const settingsPath = conversationSettingsPath({
      conversationId,
      conversationDir: join(workspaceDir, conversationId),
    });
    writeFileSync(settingsPath, JSON.stringify({ sandbox: { image: { workspaceMount: "full" } } }));

    expect(resolveWorkspaceProjection(workspaceDir, address)).toMatchObject({
      doorPolicy: "trusted",
      layout: "full",
      mounts: [{ source: workspaceDir, target: "/workspace" }],
    });
  });

  test("canonical conversation policy overrides a trusted global office", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    });
    updateConversationSettings(
      { conversationId, conversationDir: join(workspaceDir, conversationId) },
      {
        sandbox: { workspace: { doorPolicy: "isolated" } },
      },
    );

    expect(resolveWorkspaceProjection(workspaceDir, address)).toMatchObject({
      doorPolicy: "isolated",
      layout: "conversation",
    });
  });

  test("recreates missing trusted support roots with their required types", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "shared-support" } },
    });

    resolveWorkspaceProjection(workspaceDir, address);
    rmSync(join(workspaceDir, "MEMORY.md"));
    rmSync(join(workspaceDir, "skills"), { recursive: true });
    rmSync(join(workspaceDir, "events"), { recursive: true });
    resolveWorkspaceProjection(workspaceDir, address);

    expect(lstatSync(join(workspaceDir, "MEMORY.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspaceDir, "skills")).isDirectory()).toBe(true);
    expect(lstatSync(join(workspaceDir, "events")).isDirectory()).toBe(true);
  });

  test.each([
    ["conversation symlink", (root: string) => symlinkSync(root, join(root, conversationId))],
    ["conversation file", (root: string) => writeFileSync(join(root, conversationId), "wrong")],
  ])("rejects a suspicious %s", (_label, arrange) => {
    arrange(workspaceDir);
    expect(() => resolveWorkspaceProjection(workspaceDir, address)).toThrow(
      /regular non-symlink directory/,
    );
  });

  test("rejects wrong-type trusted support roots", () => {
    updateGlobalSettings({
      sandbox: { workspace: { doorPolicy: "trusted", layout: "shared-support" } },
    });
    mkdirSync(join(workspaceDir, "MEMORY.md"));

    expect(() => resolveWorkspaceProjection(workspaceDir, address)).toThrow(
      /workspace memory must be a regular non-symlink file/i,
    );
  });

  test("fails closed on malformed host settings", () => {
    writeFileSync(join(stateDir, "settings.json"), "{ broken");

    expect(() => resolveWorkspaceProjection(workspaceDir, address)).toThrow(
      /settings are malformed/,
    );
  });

  test.each(["", ".", "..", "../events", "nested/id", "nested\\id", "nul\0id"])(
    "rejects unsafe conversation id %j",
    (id) => {
      // The address factory owns identity validation now, so an unsafe id can
      // never reach the projection.
      expect(() =>
        resolveWorkspaceProjection(workspaceDir, createOfficeAddress("slack", id)),
      ).toThrow(/Conversation id/);
    },
  );
});
