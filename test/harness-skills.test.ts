import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  parseFrontmatter,
} from "../src/harness/index.js";

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

  test("returns empty string when no skills are visible", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });
});
