import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as log from "../log.js";
import { createGlobalSettingsFile } from "../settings/index.js";
import {
  readPlatformChannelKind,
  recordPlatformChannelKind,
  resolveWorkspaceProjection,
} from "../office/projection.js";
import { createOfficeAddress, createWorkspace, officeKey } from "../office/index.js";
import type { Office, Workspace } from "../office/types.js";

const address = createOfficeAddress("slack", "C123");
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

  test("materializes the office directory and shared roots with the expected types", () => {
    resolveWorkspaceProjection(office);
    expect(lstatSync(join(workspaceDir, officeSegment)).isDirectory()).toBe(true);
    expect(lstatSync(join(workspaceDir, "MEMORY.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspaceDir, "skills")).isDirectory()).toBe(true);
  });

  test("a channel kind snapshot updates in place and survives rereads", () => {
    recordPlatformChannelKind(office, "public_channel");
    expect(readPlatformChannelKind(office)).toBe("public_channel");
    expect(resolveWorkspaceProjection(office).visibility).toBe("public");

    recordPlatformChannelKind(office, "private_channel");
    expect(readPlatformChannelKind(office)).toBe("private_channel");
    expect(resolveWorkspaceProjection(office).visibility).toBe("private");
  });

  test("a corrupt channel kind file is treated as unknown (private)", () => {
    recordPlatformChannelKind(office, "public_channel");
    writeFileSync(join(office.stateDir, "channel-kind"), "banana\n");

    expect(readPlatformChannelKind(office)).toBeUndefined();
    expect(resolveWorkspaceProjection(office)).toMatchObject({
      visibility: "private",
      source: "unknown",
    });
  });

  test("warns and treats the office as private when channel kind metadata cannot be read", () => {
    recordPlatformChannelKind(office, "public_channel");
    const channelKindPath = join(office.stateDir, "channel-kind");
    rmSync(channelKindPath);
    mkdirSync(channelKindPath);
    const warning = vi.spyOn(log, "logWarning").mockImplementation(() => {});

    expect(resolveWorkspaceProjection(office)).toMatchObject({
      visibility: "private",
      source: "unknown",
    });
    expect(warning).toHaveBeenCalledWith(
      "Could not read platform channel kind; treating the office as private",
      expect.stringContaining(channelKindPath),
    );
  });

  test("recreates missing shared roots with their required types", () => {
    resolveWorkspaceProjection(office);
    rmSync(join(workspaceDir, "MEMORY.md"));
    rmSync(join(workspaceDir, "skills"), { recursive: true });
    resolveWorkspaceProjection(office);

    expect(lstatSync(join(workspaceDir, "MEMORY.md")).isFile()).toBe(true);
    expect(lstatSync(join(workspaceDir, "skills")).isDirectory()).toBe(true);
  });

  test.each([
    ["workspace root symlink", (root: string) => symlinkSync(root, join(root, "skills"))],
    ["conversation symlink", (root: string) => symlinkSync(root, join(root, officeSegment))],
    ["conversation file", (root: string) => writeFileSync(join(root, officeSegment), "wrong")],
  ])("rejects a suspicious %s", (_label, arrange) => {
    arrange(workspaceDir);
    expect(() => resolveWorkspaceProjection(office)).toThrow(/regular non-symlink directory/);
  });

  test("rejects a wrong-type shared memory root", () => {
    mkdirSync(join(workspaceDir, "MEMORY.md"));
    expect(() => resolveWorkspaceProjection(office)).toThrow(
      /workspace memory must be a regular non-symlink file/i,
    );
  });

  test("fails closed on a malformed conversation settings file", () => {
    mkdirSync(office.stateDir, { recursive: true });
    writeFileSync(join(office.stateDir, "settings.json"), "{ broken");
    expect(() => resolveWorkspaceProjection(office)).toThrow(/Malformed settings file/);
  });

  test.each(["", ".", "..", "../public", "nested/id", "nested\\id", "nul\0id"])(
    "rejects unsafe conversation id %j",
    (id) => {
      expect(() =>
        resolveWorkspaceProjection(workspace.office(createOfficeAddress("slack", id))),
      ).toThrow(/Conversation id/);
    },
  );
});
