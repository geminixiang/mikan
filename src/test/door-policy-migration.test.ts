import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  loadGlobalSettings,
  loadOfficeVisibilityOverride,
  resolveConversationSettings,
} from "../settings/index.js";
import { migrateLegacyDoorPolicy } from "../settings/migrate.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-door-migration-"));
  mkdirSync(join(stateDir, "workspace"));
  process.env.MIKAN_STATE_DIR = stateDir;
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

function workspace() {
  return createWorkspace({ root: join(stateDir, "workspace"), stateDir });
}

function office(id: string, settings?: unknown): Office {
  const value = workspace().office(createOfficeAddress("slack", id));
  value.ensure();
  if (settings !== undefined) {
    mkdirSync(value.stateDir, { recursive: true });
    writeFileSync(join(value.stateDir, "settings.json"), JSON.stringify(settings));
  }
  return value;
}

function writeGlobal(settings: unknown) {
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify(settings));
}

const llm = { provider: "anthropic", model: "m", thinkingLevel: "off" };

describe("retired door-policy settings", () => {
  test("still load but never reach AgentConfig", () => {
    writeGlobal({
      llm,
      sandbox: { cpus: "0.5", image: { workspaceMount: "private" } },
    });
    const full = office("C1", {
      sandbox: { memory: "2g", workspace: { doorPolicy: "trusted", layout: "full" } },
    });

    expect(loadGlobalSettings().sandbox).toEqual({ cpus: "0.5" });
    expect(resolveConversationSettings(full).sandbox).toEqual({ cpus: "0.5", memory: "2g" });
  });
});

describe("migrateLegacyDoorPolicy", () => {
  test("removes retired keys everywhere and keeps every other setting", () => {
    writeGlobal({
      llm,
      sandbox: {
        cpus: "0.5",
        boost: { cpus: "4" },
        image: { workspaceMount: "private" },
        defaultSharedVault: "claw",
      },
    });
    const full = office("C1", {
      llm: { model: "conversation-model" },
      sandbox: { image: { workspaceMount: "full" } },
      mcpServers: { x: { url: "https://x.example" } },
    });
    const newStyleFull = office("C2", {
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    });
    const untouched = office("C3", { slack: { replyMode: "thread" } });
    const marker = office("C4", {});

    const report = migrateLegacyDoorPolicy(workspace());

    expect(report.global).toEqual(["sandbox.image.workspaceMount"]);
    expect(report.conversations).toEqual([
      { key: full.key, removed: ["sandbox.image.workspaceMount"] },
      { key: newStyleFull.key, removed: ["sandbox.workspace"] },
    ]);
    expect(JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"))).toEqual({
      llm,
      sandbox: { cpus: "0.5", boost: { cpus: "4" }, defaultSharedVault: "claw" },
    });
    expect(JSON.parse(readFileSync(join(full.stateDir, "settings.json"), "utf8"))).toEqual({
      llm: { model: "conversation-model" },
      mcpServers: { x: { url: "https://x.example" } },
    });
    expect(JSON.parse(readFileSync(join(newStyleFull.stateDir, "settings.json"), "utf8"))).toEqual(
      {},
    );
    expect(statSync(join(newStyleFull.stateDir, "settings.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(untouched.stateDir, "settings.json"), "utf8")).toBe(
      JSON.stringify({ slack: { replyMode: "thread" } }),
    );
    expect(readFileSync(join(marker.stateDir, "settings.json"), "utf8")).toBe("{}");
  });

  test("carries an explicit shared-support private visibility into office.visibility", () => {
    writeGlobal({ llm });
    const privateShared = office("C1", {
      sandbox: {
        workspace: { doorPolicy: "trusted", layout: "shared-support", visibility: "private" },
      },
    });

    const report = migrateLegacyDoorPolicy(workspace());

    expect(report.conversations).toEqual([
      { key: privateShared.key, removed: ["sandbox.workspace"], visibility: "private" },
    ]);
    expect(loadOfficeVisibilityOverride(privateShared)).toBe("private");
  });

  test("reports and skips a malformed file instead of rewriting it", () => {
    writeGlobal({ llm });
    const broken = office("C1");
    mkdirSync(broken.stateDir, { recursive: true });
    writeFileSync(join(broken.stateDir, "settings.json"), "{ broken");

    const report = migrateLegacyDoorPolicy(workspace());

    expect(report.skipped).toEqual([expect.objectContaining({ key: broken.key })]);
    expect(readFileSync(join(broken.stateDir, "settings.json"), "utf8")).toBe("{ broken");
  });

  test("is idempotent", () => {
    writeGlobal({ llm, sandbox: { image: { workspaceMount: "full" } } });
    office("C1", { sandbox: { workspace: { doorPolicy: "isolated" } } });
    migrateLegacyDoorPolicy(workspace());
    const second = migrateLegacyDoorPolicy(workspace());
    expect(second).toEqual({ global: [], conversations: [], skipped: [] });
  });
});
