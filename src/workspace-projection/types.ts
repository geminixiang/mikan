import type {
  ContainerMount,
  WorkspaceDoorPolicy,
  WorkspaceLayout,
  WorkspaceVisibility,
} from "../types.js";

interface WorkspacePromptSources {
  conversationDir: string;
  conversationMemoryPath: string;
  conversationSkillsDir: string;
  globalMemoryPath?: string;
  globalSkillsDir?: string;
  /** True when globalMemoryPath is mounted read-only (shared-support + private visibility). */
  globalMemoryReadOnly?: boolean;
}

export interface WorkspaceProjection {
  doorPolicy: WorkspaceDoorPolicy;
  layout: WorkspaceLayout;
  /** Only meaningful for shared-support layout; "public" is the default and preserves prior read-write behavior. */
  visibility: WorkspaceVisibility;
  mounts: ContainerMount[];
  promptSources: WorkspacePromptSources;
}
