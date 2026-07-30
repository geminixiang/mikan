import type { SandboxConfig } from "../sandbox/types.js";

export interface BootPlan {
  mode: "ext" | "office" | "env" | "help" | "version" | "onboard" | "download" | "run";
  /** argv after `ext`, handed to runExtCommand. Only set for mode "ext". */
  extArgs?: string[];
  /** argv after `office`, handed to runOfficeCommand. Only set for mode "office". */
  officeArgs?: string[];
  stateDir: string;
  /** Resolved working directory; defaults to `<stateDir>/workspace`. */
  workingDir: string;
  /** True when the working directory came from argv (then it is not auto-created). */
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
  downloadChannel?: string;
}
