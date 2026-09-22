import type { SandboxConfig } from "../sandbox/types.js";

export interface OnboardIo {
  ask(query: string): Promise<string>;
  askSecret(query: string): Promise<string>;
  select(query: string, labels: string[]): Promise<number>;
  confirm(query: string): Promise<boolean>;
  print(line: string): void;
  close(): void;
}

export interface BootPlan {
  mode: "office" | "sessions" | "env" | "help" | "version" | "onboard" | "download" | "run";
  officeArgs?: string[];
  sessionsArgs?: string[];
  stateDir: string;
  workingDir: string;
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
  downloadChannel?: string;
}
