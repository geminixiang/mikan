import type { SandboxConfig } from "../sandbox/types.js";
import type { PlatformName } from "../types.js";

export type DockerCli = (args: readonly string[]) => Promise<string>;

export interface MigrationContext {
  readonly workspaceRoot: string;
  readonly stateDir: string;
  readonly dryRun: boolean;
  readonly owners: ReadonlyMap<string, PlatformName>;
  readonly enabledPlatforms: readonly PlatformName[];
  readonly sandbox: SandboxConfig;
  readonly piAgentDir: string;
  readonly modelsPath: string;
  readonly docker: DockerCli;
  report(line: string): void;
}

export interface Migration {
  readonly id: string;
  readonly summary: string;
  run(context: MigrationContext): Promise<void>;
}

export interface AppliedMigration {
  readonly id: string;
  readonly appliedAt: string;
}
