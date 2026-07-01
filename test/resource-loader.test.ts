import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MikanResourceLoader } from "../src/harness/resource-loader.js";

let workspaceDir: string;
let conversationDir: string;

function writeSkill(dir: string, name: string, description: string): void {
  const skillDir = join(dir, "skills", name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
  );
}

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "mikan-resource-loader-workspace-"));
  conversationDir = join(workspaceDir, "conv-1");
  mkdirSync(conversationDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("MikanResourceLoader", () => {
  test("load() picks up skills present on disk", () => {
    writeSkill(workspaceDir, "greet", "Greets the user");
    const loader = new MikanResourceLoader(conversationDir, workspaceDir, workspaceDir);

    const loaded = loader.load();

    expect(loaded.skills.map((s) => s.name)).toEqual(["greet"]);
  });

  test("reloadMemory() reuses the last load()'s skills, ignoring new skills added since", () => {
    writeSkill(workspaceDir, "greet", "Greets the user");
    const loader = new MikanResourceLoader(conversationDir, workspaceDir, workspaceDir);
    loader.load();

    // A skill added after load() should NOT show up via reloadMemory() —
    // skills are cached until the next full load().
    writeSkill(workspaceDir, "farewell", "Says goodbye");
    const reloaded = loader.reloadMemory();

    expect(reloaded.skills.map((s) => s.name)).toEqual(["greet"]);
  });

  test("reloadMemory() still picks up fresh MEMORY.md content every call", () => {
    const loader = new MikanResourceLoader(conversationDir, workspaceDir, workspaceDir);
    loader.load();

    writeFileSync(join(conversationDir, "MEMORY.md"), "updated memory content");
    const reloaded = loader.reloadMemory();

    expect(reloaded.memory).toContain("updated memory content");
  });

  test("a subsequent load() re-walks skills and picks up new ones", () => {
    writeSkill(workspaceDir, "greet", "Greets the user");
    const loader = new MikanResourceLoader(conversationDir, workspaceDir, workspaceDir);
    loader.load();

    writeSkill(workspaceDir, "farewell", "Says goodbye");
    const reloaded = loader.load();

    expect(reloaded.skills.map((s) => s.name).toSorted()).toEqual(["farewell", "greet"]);
  });
});
