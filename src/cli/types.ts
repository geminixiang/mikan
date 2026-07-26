import type { SandboxConfig } from "../sandbox/types.js";

export interface BootPlan {
  mode: "ext" | "env" | "help" | "version" | "onboard" | "download" | "run";
  /** argv after `ext`, handed to runExtCommand. Only set for mode "ext". */
  extArgs?: string[];
  stateDir: string;
  /** Resolved working directory; defaults to `<stateDir>/workspace`. */
  workingDir: string;
  /** True when the working directory came from argv (then it is not auto-created). */
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
  downloadChannel?: string;
}

export interface ResolvedGitSource {
  /** Local directory holding the extension (clone root or a subpath within). */
  dir: string;
  /** Remove the temporary clone. */
  cleanup: () => void;
}
