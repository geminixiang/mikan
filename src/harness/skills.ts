import type { Office } from "../office/index.js";
import type { MikanSkill, SkillDiagnostic, LoadSkillsResult } from "./types.js";
import type { WorkspaceProjection } from "../office/types.js";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import * as log from "../log.js";

/** Register skills under their prompt-side paths; a later source overrides an earlier one. */
function addSkills(
  skillMap: Map<string, MikanSkill>,
  skills: MikanSkill[],
  rewritePath: (path: string) => string,
): void {
  for (const skill of skills) {
    skill.filePath = rewritePath(skill.filePath);
    skill.baseDir = rewritePath(skill.baseDir);
    skillMap.set(skill.name, skill);
  }
}

/** Conversation skill entries that are symlinks are refused, and reported to the prompt. */
function skippedSymlinkPaths(
  diagnostics: SkillDiagnostic[],
  translatePath: (path: string) => string,
): string[] {
  const skipped: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.code !== "symlink") continue;
    log.logWarning("Skipping conversation skill entry (symlink)", diagnostic.path);
    skipped.push(translatePath(diagnostic.path));
  }
  return skipped;
}

export function loadMikanSkills(
  office: Office,
  workspacePath: string,
  projection: WorkspaceProjection,
): { skills: MikanSkill[]; skippedSkillLinks: string[] } {
  const skillMap = new Map<string, MikanSkill>();

  // workspacePath is the runtime-side root (e.g. /workspace); host paths under
  // the workspace root translate onto it for prompt references.
  const hostWorkspacePath = office.workspace.root;
  const translatePath = (hostPath: string): string =>
    hostPath.startsWith(hostWorkspacePath)
      ? workspacePath + hostPath.slice(hostWorkspacePath.length)
      : hostPath;

  const workspaceSkillsDir = projection.promptSources.globalSkillsDir;
  if (workspaceSkillsDir) {
    const loaded = loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" });
    addSkills(skillMap, loaded.skills, translatePath);
  }

  const conversationSkills = loadSkillsFromDir({
    dir: projection.promptSources.conversationSkillsDir,
    source: "channel",
    rejectSymlinks: true,
  });
  const skippedSkillLinks = skippedSymlinkPaths(conversationSkills.diagnostics, translatePath);
  addSkills(skillMap, conversationSkills.skills, translatePath);

  return { skills: Array.from(skillMap.values()), skippedSkillLinks };
}
export type { LoadSkillsResult } from "./types.js";
export type { MikanSkill } from "./types.js";
export type { SkillDiagnostic } from "./types.js";

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
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
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

function loadSkillFromFile(filePath: string, source: string): LoadSkillsResult {
  const diagnostics: SkillDiagnostic[] = [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { values, body } = parseFrontmatter(raw);
    const skillDir = dirname(filePath);
    const name = values.name || basename(skillDir);
    const description = values.description ?? "";

    if (!description.trim()) {
      diagnostics.push({ type: "warning", message: "description is required", path: filePath });
      return { skills: [], diagnostics };
    }
    for (const error of validateSkill(name, description)) {
      diagnostics.push({ type: "warning", message: error, path: filePath });
    }

    return {
      skills: [
        {
          name,
          description,
          content: body.trim(),
          filePath,
          baseDir: skillDir,
          source,
          disableModelInvocation: values["disable-model-invocation"] === "true",
        },
      ],
      diagnostics,
    };
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: error instanceof Error ? error.message : "failed to parse skill file",
      path: filePath,
    });
    return { skills: [], diagnostics };
  }
}

/**
 * Load skills from a directory tree.
 * - A directory containing `SKILL.md` is a skill root; no further recursion.
 * - Direct `.md` children of the top-level directory load as skills.
 * - Dot-directories and `node_modules` are skipped.
 */
export function loadSkillsFromDir(options: {
  dir: string;
  source: string;
  /**
   * Refuse to follow symlinks on any path this load would read, skipping the
   * offending entry with a `code: "symlink"` diagnostic instead of loading
   * it. For untrusted trees (conversation offices) the host must never
   * follow an agent-created link; entries the loader never reads — dot
   * directories, vendored node_modules — cannot disqualify anything.
   */
  rejectSymlinks?: boolean;
}): LoadSkillsResult {
  const rejectSymlinks = options.rejectSymlinks === true;
  if (rejectSymlinks && isSymlink(options.dir)) {
    return {
      skills: [],
      diagnostics: [
        {
          type: "warning",
          code: "symlink",
          message: "Skills directory is a symlink; skipped",
          path: options.dir,
        },
      ],
    };
  }
  return loadSkillsFromDirInternal(options.dir, options.source, true, rejectSymlinks);
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function symlinkDiagnostic(path: string): SkillDiagnostic {
  return {
    type: "warning",
    code: "symlink",
    message: "Skill entry is a symlink; skipped",
    path,
  };
}

function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
  rejectSymlinks: boolean,
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
    if (rejectSymlinks && skillFile.isSymbolicLink()) {
      diagnostics.push(symlinkDiagnostic(join(dir, skillFile.name)));
      return { skills, diagnostics };
    }
    return loadSkillFromFile(join(dir, skillFile.name), source);
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = join(dir, entry.name);

    const directory = isDirectoryLike(dir, entry);
    if (!directory && !(includeRootFiles && entry.name.endsWith(".md") && isFileLike(dir, entry)))
      continue;
    if (rejectSymlinks && entry.isSymbolicLink()) {
      diagnostics.push(symlinkDiagnostic(fullPath));
      continue;
    }
    const result = directory
      ? loadSkillsFromDirInternal(fullPath, source, false, rejectSymlinks)
      : loadSkillFromFile(fullPath, source);
    skills.push(...result.skills);
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
