import type { ContainerMount, WorkspaceDoorPolicy, WorkspaceLayout } from "../types.js";

interface WorkspacePromptSources {
  conversationDir: string;
  conversationMemoryPath: string;
  conversationSkillsDir: string;
  globalMemoryPath?: string;
  globalSkillsDir?: string;
}

export interface WorkspaceProjection {
  doorPolicy: WorkspaceDoorPolicy;
  layout: WorkspaceLayout;
  mounts: ContainerMount[];
  promptSources: WorkspacePromptSources;
}
