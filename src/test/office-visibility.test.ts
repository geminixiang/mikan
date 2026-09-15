import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createGlobalSettingsFile,
  setOfficeVisibilityOverride,
  updateConversationSettings,
} from "../config.js";
import {
  recordPlatformChannelKind,
  resolveOfficeVisibility,
  resolveWorkspaceProjection,
} from "../office/projection.js";
import {
  createOfficeAddress,
  createWorkspace,
  type Office,
  type Workspace,
} from "../office/index.js";

let stateDir: string;
let workspace: Workspace;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-office-visibility-"));
  mkdirSync(join(stateDir, "workspace"));
  process.env.MIKAN_STATE_DIR = stateDir;
  createGlobalSettingsFile(stateDir);
  workspace = createWorkspace({ root: join(stateDir, "workspace"), stateDir });
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

function office(
  id: string,
  kind?: "public_channel" | "private_channel" | "im" | "external",
): Office {
  const value = workspace.office(createOfficeAddress("slack", id));
  value.ensure();
  if (kind) recordPlatformChannelKind(value, kind);
  return value;
}

describe("resolveOfficeVisibility", () => {
  test("follows the platform conversation kind", () => {
    expect(resolveOfficeVisibility(office("C1", "public_channel"))).toEqual({
      visibility: "public",
      source: "platform",
    });
    for (const kind of ["private_channel", "im", "external"] as const) {
      expect(resolveOfficeVisibility(office(`X${kind}`, kind))).toEqual({
        visibility: "private",
        source: "platform",
      });
    }
  });

  test("an unknown kind fails closed to private", () => {
    expect(resolveOfficeVisibility(office("C9"))).toEqual({
      visibility: "private",
      source: "unknown",
    });
  });

  test("an operator may mark a public channel private, never the reverse", () => {
    const pub = office("C1", "public_channel");
    setOfficeVisibilityOverride(pub, "private");
    expect(resolveOfficeVisibility(pub)).toEqual({ visibility: "private", source: "override" });
    setOfficeVisibilityOverride(pub, null);
    expect(resolveOfficeVisibility(pub)).toEqual({ visibility: "public", source: "platform" });

    const dm = office("D1", "im");
    setOfficeVisibilityOverride(dm, "private");
    expect(resolveOfficeVisibility(dm).visibility).toBe("private");
  });

  test("legacy door-policy settings no longer widen visibility", () => {
    const dm = office("D1", "im");
    updateConversationSettings(dm, {
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    });
    expect(resolveOfficeVisibility(dm)).toEqual({ visibility: "private", source: "platform" });
  });
});

describe("resolveWorkspaceProjection", () => {
  test("a public office: own dir rw, public view ro, global knowledge rw", () => {
    const own = office("C1", "public_channel");
    office("C2", "public_channel");
    office("D1", "im");

    const projection = resolveWorkspaceProjection(own);

    expect(projection.visibility).toBe("public");
    expect(projection.mounts).toEqual([
      { source: own.dir, target: `/workspace/${own.key}` },
      { source: workspace.memoryPath, target: "/workspace/MEMORY.md" },
      { source: workspace.skillsDir, target: "/workspace/skills" },
      { source: join(workspace.stateDir, "public"), target: "/workspace/public", readOnly: true },
    ]);
    // The host public view links every public office, never a private one.
    const view = join(workspace.stateDir, "public");
    const entries = readdirSync(view);
    expect(entries.toSorted()).toEqual([own.key, office("C2").key].toSorted());
    expect(readlinkSync(join(view, office("C2").key))).toBe(office("C2").dir);
    expect(existsSync(join(view, office("D1").key))).toBe(false);
  });

  test("a private office: own dir rw, public view ro, global knowledge ro", () => {
    const own = office("D1", "im");
    office("C1", "public_channel");

    const projection = resolveWorkspaceProjection(own);

    expect(projection.visibility).toBe("private");
    expect(projection.mounts).toEqual([
      { source: own.dir, target: `/workspace/${own.key}` },
      { source: workspace.memoryPath, target: "/workspace/MEMORY.md", readOnly: true },
      { source: workspace.skillsDir, target: "/workspace/skills", readOnly: true },
      { source: join(workspace.stateDir, "public"), target: "/workspace/public", readOnly: true },
    ]);
    expect(projection.promptSources.globalKnowledgeReadOnly).toBe(true);
    expect(projection.promptSources.publicOfficesDir).toBe(join(workspace.stateDir, "public"));
  });

  test("the public view drops an office that becomes private", () => {
    const own = office("D1", "im");
    const pub = office("C1", "public_channel");
    resolveWorkspaceProjection(own);
    expect(existsSync(join(workspace.stateDir, "public", pub.key))).toBe(true);

    setOfficeVisibilityOverride(pub, "private");
    resolveWorkspaceProjection(own);
    expect(existsSync(join(workspace.stateDir, "public", pub.key))).toBe(false);
  });

  test("no layout mounts the workspace root", () => {
    const own = office("D1", "im");
    updateConversationSettings(own, {
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    });
    const projection = resolveWorkspaceProjection(own);
    expect(projection.mounts.some((mount) => mount.source === workspace.root)).toBe(false);
    expect(projection.legacyFull).toBe(true);
  });
});
