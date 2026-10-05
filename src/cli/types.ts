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
  mode: "migrate" | "office" | "env" | "help" | "version" | "onboard" | "run";
  migrateArgs?: string[];
  officeArgs?: string[];
  stateDir: string;
  workingDir: string;
  workingDirExplicit: boolean;
  sandbox: SandboxConfig;
}
