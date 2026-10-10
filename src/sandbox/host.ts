import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { HostSandboxConfig, SandboxAdapter } from "./types.js";

function parseHostSandboxArg(value: string): HostSandboxConfig | undefined {
  if (value === "host") {
    return { type: "host" };
  }
  return undefined;
}

export const hostSandboxAdapter: SandboxAdapter<HostSandboxConfig> = {
  type: "host",
  credentials: { env: false, fileMounts: false },
  workspace: { managedProjection: false },
  parse: parseHostSandboxArg,
  createEnv: (_config, options) => new NodeExecutionEnv({ cwd: options.cwd }),
};
