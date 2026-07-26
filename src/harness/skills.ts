/**
 * Skill loading for the mikan harness.
 *
 * Skills follow the Agent Skills layout: a directory containing a `SKILL.md`
 * with YAML frontmatter (`name`, `description`), or standalone `.md` files in
 * the root of a skills directory. Discovery mirrors the behavior mikan's
 * system prompt documents: a directory with a `SKILL.md` is a skill root
 * (no further recursion), other directories are traversed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import type { LoadSkillsResult, MikanSkill, SkillDiagnostic } from "./types.js";

export type { LoadSkillsResult, MikanSkill, SkillDiagnostic } from "./types.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

interface Frontmatter {
  values: Record<string, string>;
  body: string;
}

/**
 * Parse simple `key: value` YAML frontmatter delimited by `---` lines.
 * Quoted values are unquoted; nested structures are not supported.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { values: {}, body: content };

  const values: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return { values, body: content.slice(match[0].length) };
}

function validateSkill(name: string, description: string): string[] {
  const errors: string[] = [];
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (
    !/^[a-z0-9-]+$/.test(name) ||
    name.startsWith("-") ||
    name.endsWith("-") ||
    name.includes("--")
  ) {
    errors.push("name must be lowercase a-z, 0-9 and single hyphens, not at the edges");
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}

function loadSkillFromFile(
  filePath: string,
  source: string,
): {
  skill: MikanSkill | null;
  diagnostics: SkillDiagnostic[];
} {
  const diagnostics: SkillDiagnostic[] = [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { values, body } = parseFrontmatter(raw);
    const skillDir = dirname(filePath);
    const name = values.name || basename(skillDir);
    const description = values.description ?? "";

    if (!description.trim()) {
      diagnostics.push({ type: "warning", message: "description is required", path: filePath });
      return { skill: null, diagnostics };
    }
    for (const error of validateSkill(name, description)) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    return {
      skill: {
        name,
        description,
        content: body.trim(),
        filePath,
        baseDir: skillDir,
        source,
        disableModelInvocation: values["disable-model-invocation"] === "true",
      },
      diagnostics,
    };
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: error instanceof Error ? error.message : "failed to parse skill file",
      path: filePath,
    });
    return { skill: null, diagnostics };
  }
}

/**
 * Load skills from a directory tree.
 * - A directory containing `SKILL.md` is a skill root; no further recursion.
 * - Direct `.md` children of the top-level directory load as skills.
 * - Dot-directories and `node_modules` are skipped.
 */
export function loadSkillsFromDir(options: { dir: string; source: string }): LoadSkillsResult {
  return loadSkillsFromDirInternal(options.dir, options.source, true);
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
): LoadSkillsResult {
  const skills: MikanSkill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  if (!existsSync(dir)) return { skills, diagnostics };

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { skills, diagnostics };
  }

  const skillFile = entries.find((entry) => entry.name === "SKILL.md" && isFileLike(dir, entry));
  if (skillFile) {
    const result = loadSkillFromFile(join(dir, skillFile.name), source);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);

    if (isDirectoryLike(dir, entry)) {
      const subResult = loadSkillsFromDirInternal(fullPath, source, false);
      skills.push(...subResult.skills);
      diagnostics.push(...subResult.diagnostics);
      continue;
    }
    if (!includeRootFiles || !entry.name.endsWith(".md") || !isFileLike(dir, entry)) continue;

    const result = loadSkillFromFile(fullPath, source);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

function isFileLike(
  dir: string,
  entry: { name: string; isFile(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isFile();
  } catch {
    return false;
  }
}

function isDirectoryLike(
  dir: string,
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format skills for a system prompt using the Agent Skills XML block.
 * Skills with `disableModelInvocation` are excluded.
 */
export function formatSkillsForPrompt(skills: MikanSkill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    if (skill.inline) {
      // Inline skills carry their body: the agent cannot read their file.
      lines.push(`    <instructions>${escapeXml(skill.content)}</instructions>`);
    } else {
      lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
