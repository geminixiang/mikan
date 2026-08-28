import type {
  ContainerMount,
  WorkspaceDoorPolicy,
  WorkspaceLayout,
  WorkspaceVisibility,
} from "../types.js";

/**
 * The conversation's platform-native channel kind, using the platform's own
 * vocabulary (Slack conversation types), not a mikan-invented one. Recorded
 * at message intake and used to derive the workspace projection when no
 * explicit workspace setting exists: public channels share workspace memory
 * read-write, private channels read it without writing back, DMs and
 * externally shared channels stay isolated.
 */
export type PlatformChannelKind = "public_channel" | "private_channel" | "im" | "external";

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
