import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatSkillsForPrompt, loadSkillsFromDir, parseFrontmatter } from "../harness/index.js";

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
    expect(diagnostics[0].message).toContain("description is required");
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
    // The production regression: a skill vendoring node_modules carries npm's
    // .bin symlinks, but the loader never reads node_modules — the skill and
    // its siblings must load.
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
    expect(skills[0].baseDir).toBe(real);
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

    const { skills } = loadSkillsFromDir({ dir, source: "package:x" });

    expect(skills.map((skill) => skill.name)).toEqual(["linked-skill"]);
  });
});

describe("formatSkillsForPrompt", () => {
  test("renders the available_skills XML block and hides disabled skills", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "visible",
        description: "A & B",
        content: "",
        filePath: "/skills/visible/SKILL.md",
        baseDir: "/skills/visible",
        source: "workspace",
      },
      {
        name: "hidden",
        description: "Hidden",
        content: "",
        filePath: "/skills/hidden/SKILL.md",
        baseDir: "/skills/hidden",
        source: "workspace",
        disableModelInvocation: true,
      },
    ]);
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("<name>visible</name>");
    expect(prompt).toContain("A &amp; B");
    expect(prompt).not.toContain("hidden");
  });

  test("inline skills embed instructions instead of a file location", () => {
    const prompt = formatSkillsForPrompt([
      {
        name: "triage",
        description: "Triage follow-ups",
        content: "Always triage <first>.",
        filePath: "/state/packages/toolkit/skills/triage/SKILL.md",
        baseDir: "/state/packages/toolkit/skills/triage",
        source: "package:toolkit",
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
