import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createRunner } from "../harness/runner.js";
import type { RunnerExecutionContext } from "../harness/types.js";
import { resolveWorkspaceProjection } from "../office/projection.js";
import type { Workspace } from "../office/types.js";
import type { RunnerFactory } from "../runtime/types.js";
import { createMountedRuntimePathContext } from "../sandbox/utils.js";

export function localExecution(workspace: Workspace): RunnerExecutionContext {
  const pathContext = createMountedRuntimePathContext(workspace.root, workspace.root);
  const env = new NodeExecutionEnv({ cwd: workspace.root });
  return {
    env: () => env,
    sandboxConfig: () => ({ type: "host" }),
    resolveForRun: async (context) => ({
      pathContext,
      projection: resolveWorkspaceProjection(workspace.office(context.address)),
    }),
  };
}

export const localRunnerFactory: RunnerFactory = (options) =>
  createRunner({ ...options, execution: localExecution(options.office.workspace) });
