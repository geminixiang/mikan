import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import type { LoadSkillsResult, Skill } from "./types.js";

export type { LoadSkillsResult, Skill } from "./types.js";

export function loadSkillsFromDir(options: { dir: string; source: string }): LoadSkillsResult {
  return loadSkillsFromDirInternal(options.dir, options.source, true);
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
): LoadSkillsResult {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  if (!existsSync(dir)) return result;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name !== "SKILL.md") continue;
    const filePath = join(dir, entry.name);
    if (entry.isFile()) tryLoadSkill(result, filePath, source);
    return result;
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const filePath = join(dir, entry.name);
    const stats = entry.isSymbolicLink() ? statSync(filePath) : undefined;
    const isDirectory = entry.isDirectory() || stats?.isDirectory() === true;
    const isFile = entry.isFile() || stats?.isFile() === true;
    if (isDirectory) {
      const child = loadSkillsFromDirInternal(filePath, source, false);
      result.skills.push(...child.skills);
      result.diagnostics.push(...child.diagnostics);
    } else if (includeRootFiles && isFile && entry.name.endsWith(".md")) {
      tryLoadSkill(result, filePath, source);
    }
  }
  return result;
}

function tryLoadSkill(result: LoadSkillsResult, filePath: string, source: string): void {
  try {
    result.skills.push(loadSkill(filePath, source));
  } catch (error) {
    result.diagnostics.push({
      type: "warning",
      message: error instanceof Error ? error.message : String(error),
      path: filePath,
    });
  }
}

function loadSkill(filePath: string, source: string): Skill {
  const content = readFileSync(filePath, "utf-8");
  const frontmatter = parseFrontmatter(content);
  const baseDir = dirname(filePath);
  const name = String(frontmatter.name || basename(baseDir));
  const description = String(frontmatter.description || "").trim();
  if (!description) throw new Error(`Skill ${filePath} is missing description`);
  return {
    name,
    description,
    filePath,
    baseDir,
    source,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  };
}

function parseFrontmatter(content: string): Record<string, string | boolean> {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---", 4);
  if (end === -1) return {};
  const result: Record<string, string | boolean> = {};
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const raw = line.slice(colon + 1).trim();
    result[key] =
      raw === "true"
        ? true
        : raw === "false"
          ? false
          : raw.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
  }
  return result;
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";
  return [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    ...visibleSkills.flatMap((skill) => [
      "  <skill>",
      `    <name>${escapeXml(skill.name)}</name>`,
      `    <description>${escapeXml(skill.description)}</description>`,
      `    <location>${escapeXml(skill.filePath)}</location>`,
      "  </skill>",
    ]),
    "</available_skills>",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
