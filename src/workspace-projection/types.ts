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
  /** Legacy layout name for callers that only display the old setting. */
  mode: "private" | "full";
  mounts: ContainerMount[];
  promptSources: WorkspacePromptSources;
}
