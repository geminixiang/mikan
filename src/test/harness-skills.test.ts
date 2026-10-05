import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  formatSkillsForPrompt,
  loadOfficeSkills,
  loadSkillsFromDir,
  parseFrontmatter,
  resolveSkillEnabled,
} from "../harness/skills.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-harness-skills-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  test("parses key/value pairs and strips quotes", () => {
    const { values, body } = parseFrontmatter(
      '---\nname: my-skill\ndescription: "Does things"\n---\n# Body\n',
    );
    expect(values).toEqual({ name: "my-skill", description: "Does things" });
    expect(body).toBe("# Body\n");
  });

  test("returns full content as body without frontmatter", () => {
    const { values, body } = parseFrontmatter("# Just markdown\n");
    expect(values).toEqual({});
    expect(body).toBe("# Just markdown\n");
  });
});

describe("loadSkillsFromDir", () => {
  test("loads SKILL.md directories and falls back to directory names", () => {
    const skillDir = join(dir, "email");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\ndescription: Send emails\n---\nUse the script in {baseDir}.\n",
    );

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "workspace" });
    expect(diagnostics).toHaveLength(0);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "email",
      description: "Send emails",
      baseDir: skillDir,
      source: "workspace",
    });
  });

  test("skips skills without a description and reports a diagnostic", () => {
    const skillDir = join(dir, "broken");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: broken\n---\nNo description.\n");

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "workspace" });
    expect(skills).toHaveLength(0);
    expect(diagnostics[0]?.message).toContain("description is required");
  });

  test("loads root-level markdown files as skills", () => {
    writeFileSync(join(dir, "notes.md"), "---\nname: notes\ndescription: Take notes\n---\nBody\n");
    const { skills } = loadSkillsFromDir({ dir, source: "channel" });
    expect(skills.map((skill) => skill.name)).toEqual(["notes"]);
  });

  test("missing directory yields no skills", () => {
    const { skills } = loadSkillsFromDir({ dir: join(dir, "nope"), source: "workspace" });
    expect(skills).toHaveLength(0);
  });
});

function writeSkill(base: string, name: string): string {
  const skillDir = join(base, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `---\ndescription: ${name}\n---\nBody\n`);
  return skillDir;
}

describe("loadSkillsFromDir with rejectSymlinks", () => {
  test("npm .bin symlinks inside vendored node_modules never disqualify a skill", () => {
    const skillDir = writeSkill(dir, "playwright-check");
    const binDir = join(skillDir, "node_modules", ".bin");
    mkdirSync(join(skillDir, "node_modules", "playwright"), { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(skillDir, "node_modules", "playwright", "cli.js"), "#!/usr/bin/env node\n");
    symlinkSync(join("..", "playwright", "cli.js"), join(binDir, "playwright"));
    writeSkill(dir, "sibling");

    const { skills, diagnostics } = loadSkillsFromDir({
      dir,
      source: "channel",
      rejectSymlinks: true,
    });

    expect(skills.map((skill) => skill.name).toSorted()).toEqual(["playwright-check", "sibling"]);
    expect(diagnostics).toHaveLength(0);
  });

  test("a symlinked skill directory is skipped per entry, siblings still load", () => {
    const real = writeSkill(dir, "real-skill");
    const elsewhere = writeSkill(join(dir, ".agents"), "linked-skill");
    symlinkSync(elsewhere, join(dir, "linked-skill"));

    const { skills, diagnostics } = loadSkillsFromDir({
      dir,
      source: "channel",
      rejectSymlinks: true,
    });

    expect(skills.map((skill) => skill.name)).toEqual(["real-skill"]);
    expect(skills[0]?.baseDir).toBe(real);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "symlink", path: join(dir, "linked-skill") }),
    ]);
  });

  test("a symlinked SKILL.md inside a real directory is skipped", () => {
    const skillDir = join(dir, "offsite");
    mkdirSync(skillDir, { recursive: true });
    const target = join(dir, ".agents", "offsite-def.md");
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(target, "---\ndescription: offsite\n---\nBody\n");
    symlinkSync(target, join(skillDir, "SKILL.md"));

    const { skills, diagnostics } = loadSkillsFromDir({
      dir,
      source: "channel",
      rejectSymlinks: true,
    });

    expect(skills).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "symlink", path: join(skillDir, "SKILL.md") }),
    ]);
  });

  test("a skills root that is itself a symlink loads nothing", () => {
    const actual = writeSkill(join(dir, "elsewhere"), "hidden");
    const linkRoot = join(dir, "skills");
    symlinkSync(join(dir, "elsewhere"), linkRoot);

    const { skills, diagnostics } = loadSkillsFromDir({
      dir: linkRoot,
      source: "channel",
      rejectSymlinks: true,
    });

    expect(skills).toHaveLength(0);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "symlink", path: linkRoot })]);
    expect(actual).toContain("hidden");
  });

  test("without the option, symlinked entries still load (trusted sources)", () => {
    const elsewhere = writeSkill(join(dir, ".agents"), "linked-skill");
    symlinkSync(elsewhere, join(dir, "linked-skill"));

    const { skills } = loadSkillsFromDir({ dir, source: "workspace" });

    expect(skills.map((skill) => skill.name)).toEqual(["linked-skill"]);
  });
});

describe("formatSkillsForPrompt", () => {
  test("lists each skill on one line under its directory and hides disabled skills", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "visible",
        description: "A & B",
        content: "",
        filePath: "/workspace/skills/visible/SKILL.md",
        baseDir: "/workspace/skills/visible",
        source: "workspace",
      },
      {
        name: "hidden",
        description: "Hidden",
        content: "",
        filePath: "/workspace/skills/hidden/SKILL.md",
        baseDir: "/workspace/skills/hidden",
        source: "workspace",
        disableModelInvocation: true,
      },
      {
        name: "local",
        description: "Channel only",
        content: "",
        filePath: "/workspace/C1/skills/local/SKILL.md",
        baseDir: "/workspace/C1/skills/local",
        source: "channel",
      },
    ]);
    expect(prompt).toContain('<available_skills dir="/workspace/skills">\n- visible: A &amp; B\n');
    expect(prompt).toContain(
      '<available_skills dir="/workspace/C1/skills">\n- local: Channel only\n',
    );
    expect(prompt).not.toContain("hidden");
    expect(prompt).not.toContain("<location>");
    expect(prompt).not.toContain("SKILL.md</");
  });

  test("names the file of a skill whose directory differs from its name", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "deploy",
        description: "Ship it",
        content: "",
        filePath: "/workspace/skills/deploy-tools/SKILL.md",
        baseDir: "/workspace/skills/deploy-tools",
        source: "workspace",
      },
    ]);
    expect(prompt).toContain("- deploy (/workspace/skills/deploy-tools/SKILL.md): Ship it");
  });

  test("inline skills embed instructions instead of a file location", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "triage",
        description: "Triage follow-ups",
        content: "Always triage <first>.",
        filePath: "/workspace/skills/triage/SKILL.md",
        baseDir: "/workspace/skills/triage",
        source: "workspace",
        inline: true,
      },
    ]);
    expect(prompt).toContain("<instructions>Always triage &lt;first&gt;.</instructions>");
    expect(prompt).not.toContain("<location>");
  });

  test("returns empty string when no skills are visible", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });
});

describe("resolveSkillEnabled", () => {
  test("global rules: skills load by default, ! excludes by glob, + adds back, - wins", () => {
    const global = ["!vendors/**", "+vendors/keep", "-tools/off", "+tools/off"];
    expect(resolveSkillEnabled("global", "tools/on", { global, conversation: [] })).toBe(true);
    expect(resolveSkillEnabled("global", "vendors/drop", { global, conversation: [] })).toBe(false);
    expect(resolveSkillEnabled("global", "vendors/keep", { global, conversation: [] })).toBe(true);
    expect(resolveSkillEnabled("global", "tools/off", { global, conversation: [] })).toBe(false);
  });

  test("a conversation override decides a global skill; without one the global rules apply", () => {
    const global = ["!vendors/**"];
    const conversation = ["+vendors/keep", "-tools/off"];
    expect(resolveSkillEnabled("global", "vendors/keep", { global, conversation })).toBe(true);
    expect(resolveSkillEnabled("global", "vendors/drop", { global, conversation })).toBe(false);
    expect(resolveSkillEnabled("global", "tools/off", { global, conversation })).toBe(false);
    expect(resolveSkillEnabled("global", "tools/on", { global, conversation })).toBe(true);
  });

  test("a conversation's own skills follow only its own rules", () => {
    expect(
      resolveSkillEnabled("conversation", "mine", { global: ["-mine"], conversation: [] }),
    ).toBe(true);
    expect(
      resolveSkillEnabled("conversation", "mine", { global: [], conversation: ["-mine"] }),
    ).toBe(false);
  });
});

describe("loadOfficeSkills", () => {
  test("lists nested skills with their directory and leaves disabled ones out of the prompt", () => {
    const globalDir = join(dir, "skills");
    const conversationDir = join(dir, "office", "skills");
    for (const [root, path, name] of [
      [globalDir, "bundle/vendors/alpha", "alpha"],
      [globalDir, "bundle/tools/beta", "beta"],
      [conversationDir, "mine", "mine"],
    ] as const) {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(
        join(root, path, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${name} skill\n---\nBody`,
      );
    }
    const { skills } = loadOfficeSkills({
      globalSkillsDir: globalDir,
      conversationSkillsDir: conversationDir,
      patterns: { global: ["!bundle/vendors/**"], conversation: [] },
    });
    expect(
      skills.map(({ name, source, directory, enabled }) => ({ name, source, directory, enabled })),
    ).toEqual([
      { name: "beta", source: "global", directory: "bundle/tools/beta", enabled: true },
      { name: "alpha", source: "global", directory: "bundle/vendors/alpha", enabled: false },
      { name: "mine", source: "conversation", directory: "mine", enabled: true },
    ]);
    const prompt = formatSkillsForPrompt(skills);
    expect(prompt).toContain("- beta:");
    expect(prompt).not.toContain("- alpha:");
  });
});
