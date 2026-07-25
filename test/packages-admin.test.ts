import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addPackage,
  inspectConversationPackages,
  refreshPackage,
  removePackage,
} from "../src/packages/index.js";

const CONVERSATION_ID = "C03045VJJAY";

let base: string;
let stateDir: string;
let workingDir: string;
let repo: string;
let source: string;

function globalSettingsFile(): string {
  return join(stateDir, "settings.json");
}

function conversationSettingsFile(): string {
  return join(stateDir, "conversations", CONVERSATION_ID, "settings.json");
}

function readPackages(path: string): string[] {
  try {
    return (JSON.parse(readFileSync(path, "utf-8")) as { packages?: string[] }).packages ?? [];
  } catch {
    return [];
  }
}

function context() {
  return {
    conversationId: CONVERSATION_ID,
    stateDir,
    conversationDir: join(workingDir, CONVERSATION_ID),
    workingDir,
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mikan-pkg-admin-"));
  stateDir = join(base, "state");
  workingDir = join(base, "workspace");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(workingDir, CONVERSATION_ID), { recursive: true });
  process.env.MIKAN_STATE_DIR = stateDir;
  writeFileSync(
    globalSettingsFile(),
    JSON.stringify({
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
    }),
  );

  repo = mkdtempSync(join(base, "repo-"));
  const ext = join(repo, "extensions", "reporter");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "index.mjs"), "export function activate() {}");
  mkdirSync(join(repo, "skills", "triage"), { recursive: true });
  writeFileSync(
    join(repo, "skills", "triage", "SKILL.md"),
    "---\nname: triage\ndescription: d\n---\nb",
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], {
    cwd: repo,
  });
  execFileSync("git", ["tag", "v1"], { cwd: repo });
  source = `file://${repo}`;
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(base, { recursive: true, force: true });
});

describe("addPackage", () => {
  test("persists the canonical source into the chosen scope", () => {
    addPackage("global", source, context());
    expect(readPackages(globalSettingsFile())).toEqual([source]);
    expect(readPackages(conversationSettingsFile())).toEqual([]);
  });

  test("a conversation add does not touch the global list", () => {
    addPackage("conversation", source, context());
    expect(readPackages(conversationSettingsFile())).toEqual([source]);
    expect(readPackages(globalSettingsFile())).toEqual([]);
  });

  test("a source that cannot be fetched is NOT persisted", () => {
    expect(() => addPackage("global", "file:///nope/missing", context())).toThrow();
    expect(readPackages(globalSettingsFile())).toEqual([]);
  });

  test("a malformed source is NOT persisted", () => {
    expect(() => addPackage("global", "not a source", context())).toThrow();
    expect(readPackages(globalSettingsFile())).toEqual([]);
  });

  test("a missing subpath is rejected before the list changes", () => {
    expect(() => addPackage("global", `${source}#nope`, context())).toThrow(/Subpath not found/);
    expect(readPackages(globalSettingsFile())).toEqual([]);
  });

  test("re-adding the same package with a new ref moves the pin instead of duplicating", () => {
    addPackage("global", `${source}@v1`, context());
    addPackage("global", source, context());
    expect(readPackages(globalSettingsFile())).toEqual([source]);
  });

  test("adding a second, different package keeps the first", () => {
    const other = mkdtempSync(join(base, "repo2-"));
    writeFileSync(join(other, "index.mjs"), "export function activate() {}");
    execFileSync("git", ["init", "-q"], { cwd: other });
    execFileSync("git", ["add", "-A"], { cwd: other });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
      cwd: other,
    });

    addPackage("global", source, context());
    addPackage("global", `file://${other}`, context());
    expect(readPackages(globalSettingsFile())).toHaveLength(2);
  });
});

describe("removePackage", () => {
  test("drops the entry but keeps the checkout for a cheap re-add", () => {
    const added = addPackage("global", source, context());
    expect(removePackage("global", added.source, context())).toBe(true);
    expect(readPackages(globalSettingsFile())).toEqual([]);
    // Still on disk: re-adding must not need the network again.
    expect(readFileSync(join(added.dir, "extensions", "reporter", "index.mjs"), "utf-8")).toContain(
      "activate",
    );
  });

  test("removing something not declared reports false", () => {
    expect(removePackage("global", source, context())).toBe(false);
  });
});

describe("refreshPackage", () => {
  test("moves an unpinned package to the new head", () => {
    const added = addPackage("global", source, context());
    writeFileSync(
      join(repo, "extensions", "reporter", "index.mjs"),
      "export function activate() {} // v2",
    );
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"], {
      cwd: repo,
    });

    refreshPackage("global", added.source, context());
    expect(readFileSync(join(added.dir, "extensions", "reporter", "index.mjs"), "utf-8")).toContain(
      "v2",
    );
  });

  test("refusing to refresh something the scope never declared", () => {
    expect(() => refreshPackage("global", source, context())).toThrow(/Not declared/);
  });
});

describe("inspectConversationPackages", () => {
  test("reports what a ready package contributes", async () => {
    addPackage("global", source, context());
    const inventory = await inspectConversationPackages(context());

    expect(inventory.global).toHaveLength(1);
    expect(inventory.global[0].ready).toBe(true);
    expect(inventory.global[0].extensions).toEqual(["reporter"]);
    expect(inventory.global[0].skills).toEqual(["triage"]);
  });

  test("a declared-but-unfetched source is reported with its error, not omitted", async () => {
    // Hand-edited settings can name something never materialized here.
    writeFileSync(
      globalSettingsFile(),
      JSON.stringify({
        llm: { provider: "anthropic", model: "claude-sonnet-4-6", thinkingLevel: "off" },
        packages: ["file:///nope/missing"],
      }),
    );
    const inventory = await inspectConversationPackages(context());
    expect(inventory.global).toHaveLength(1);
    expect(inventory.global[0].ready).toBe(false);
    expect(inventory.global[0].error).toBeTruthy();
  });

  test("a global entry shadowed by the conversation's copy is flagged", async () => {
    addPackage("global", `${source}@v1`, context());
    addPackage("conversation", source, context());

    const inventory = await inspectConversationPackages(context());
    expect(inventory.global[0].shadowed).toBe(true);
    expect(inventory.conversation[0].shadowed).toBeUndefined();
  });

  test("an unshadowed global entry is not flagged", async () => {
    addPackage("global", source, context());
    const inventory = await inspectConversationPackages(context());
    expect(inventory.global[0].shadowed).toBeUndefined();
  });

  test("a single-extension package reports its root slug", async () => {
    const solo = join(base, "solo-tool");
    mkdirSync(solo, { recursive: true });
    writeFileSync(join(solo, "index.mjs"), "export function activate() {}");
    execFileSync("git", ["init", "-q"], { cwd: solo });
    execFileSync("git", ["add", "-A"], { cwd: solo });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"], {
      cwd: solo,
    });

    addPackage("global", `file://${solo}`, context());
    const inventory = await inspectConversationPackages(context());
    expect(inventory.global[0].extensions).toEqual(["solo-tool"]);
  });
});
