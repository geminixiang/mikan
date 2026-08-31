import type { SandboxConfig } from "../sandbox/types.js";

/** Prompt/print seam for the onboard wizard, so tests can script answers. */
export interface OnboardIo {
  ask(query: string): Promise<string>;
  askSecret(query: string): Promise<string>;
  print(line: string): void;
  close(): void;
}

export interface BootPlan {
  mode: "office" | "sessions" | "env" | "help" | "version" | "onboard" | "download" | "run";
  /** argv after `office`, handed to runOfficeCommand. Only set for mode "office". */
  officeArgs?: string[];
  /** argv after `sessions`, handed to runSessionsCommand. Only set for mode "sessions". */
  sessionsArgs?: string[];
  stateDir: string;
  /** Resolved working directory; defaults to `<stateDir>/workspace`. */
  workingDir: string;
  /** True when the working directory came from argv (then it is not auto-created). */
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
  downloadChannel?: string;
}
