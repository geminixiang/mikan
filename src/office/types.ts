import type { ContainerMount, OfficeAddress, OfficeKey, WorkspaceVisibility } from "../types.js";

export interface OfficeMigrationRunSummary {
  migrated: string[];
  recovered: string[];
  unowned: string[];
  failed: string[];
  vaultKeysMigrated: string[];
  vaultConflicts: string[];
  stateDirsMigrated: string[];
  stateDirConflicts: string[];
}

export interface Workspace {
  readonly root: string;
  readonly stateDir: string;
  readonly memoryPath: string;
  readonly skillsDir: string;
  readonly agentsDir: string;
  readonly reservedNames: ReadonlySet<string>;
  office(address: OfficeAddress): Office;
}

export interface Office {
  readonly address: OfficeAddress;
  readonly key: OfficeKey;
  readonly dir: string;
  readonly memoryPath: string;
  readonly skillsDir: string;
  readonly sessionsDir: string;
  readonly attachmentsDir: string;
  readonly logPath: string;
  readonly stateDir: string;
  readonly workspace: Workspace;
  ensure(): string;
}

export type PlatformChannelKind = "public_channel" | "private_channel" | "im" | "external";

interface WorkspacePromptSources {
  conversationDir: string;
  conversationMemoryPath: string;
  conversationSkillsDir: string;
  globalMemoryPath: string;
  globalSkillsDir: string;
  globalKnowledgeReadOnly?: boolean;
}

export interface WorkspaceProjection {
  visibility: WorkspaceVisibility;
  source: "platform" | "override" | "unknown";
  mounts: ContainerMount[];
  promptSources: WorkspacePromptSources;
}
