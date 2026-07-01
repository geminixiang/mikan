/**
 * Resource loader for mikan — loads memory, skills, and project context.
 *
 * Lightweight version of pi-coding-agent's ResourceLoader.
 * Manages:
 * - MEMORY.md (workspace + conversation)
 * - skills/ (workspace + conversation, with sandbox path translation)
 * - Diagnostics for missing/broken resources
 */
import { join } from "path";
import { loadSkillsFromDir, type Skill } from "./skills.js";
import { readTextFileIfExists } from "../utils/file-guards.js";

export type { Skill } from "./skills.js";

export interface ResourceDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface LoadedResources {
  memory: string;
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}

export class MikanResourceLoader {
  constructor(
    private readonly conversationDir: string,
    /** Runtime workspace root (for sandbox path translation). May differ from host path. */
    private readonly workspaceRoot: string,
    /** Host workspace root (parent of conversationDir). Used to compute relative paths. */
    private readonly hostWorkspaceRoot: string,
  ) {}

  /** Load all resources fresh. */
  load(): LoadedResources {
    const diagnostics: ResourceDiagnostic[] = [];
    const memory = this.loadMemory(diagnostics);
    const skills = this.loadSkills(diagnostics);
    return { memory, skills, diagnostics };
  }

  private loadMemory(_diagnostics: ResourceDiagnostic[]): string {
    const parts: string[] = [];

    const workspaceMemoryPath = join(this.hostWorkspaceRoot, "MEMORY.md");
    const workspaceContent = this.readFile(workspaceMemoryPath);
    if (workspaceContent) {
      parts.push(`### Global Workspace Memory\n${workspaceContent}`);
    }

    const conversationMemoryPath = join(this.conversationDir, "MEMORY.md");
    const conversationContent = this.readFile(conversationMemoryPath);
    if (conversationContent) {
      parts.push(`### Conversation-Specific Memory\n${conversationContent}`);
    }

    return parts.length > 0 ? parts.join("\n\n") : "(no working memory yet)";
  }

  private loadSkills(diagnostics: ResourceDiagnostic[]): Skill[] {
    const skillMap = new Map<string, Skill>();

    const translatePath = (hostPath: string): string => {
      if (hostPath.startsWith(this.hostWorkspaceRoot)) {
        return this.workspaceRoot + hostPath.slice(this.hostWorkspaceRoot.length);
      }
      return hostPath;
    };

    // Workspace-level skills (global)
    const workspaceSkillsDir = join(this.hostWorkspaceRoot, "skills");
    const wsResult = loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" });
    for (const skill of wsResult.skills) {
      skill.filePath = translatePath(skill.filePath);
      skill.baseDir = translatePath(skill.baseDir);
      skillMap.set(skill.name, skill);
    }
    diagnostics.push(...wsResult.diagnostics);

    // Conversation-level skills (override workspace on name collision)
    const conversationSkillsDir = join(this.conversationDir, "skills");
    const convResult = loadSkillsFromDir({ dir: conversationSkillsDir, source: "channel" });
    for (const skill of convResult.skills) {
      skill.filePath = translatePath(skill.filePath);
      skill.baseDir = translatePath(skill.baseDir);
      skillMap.set(skill.name, skill);
    }
    diagnostics.push(...convResult.diagnostics);

    return Array.from(skillMap.values());
  }

  private readFile(filePath: string): string | undefined {
    const content = readTextFileIfExists(filePath);
    if (content === undefined) return undefined;
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    return trimmed;
  }
}
