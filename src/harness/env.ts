import { NodeExecutionEnv, type ExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * Host filesystem/exec environment for AgentHarness's internal needs (skill
 * discovery, etc). Mikan's own tools (bash/edit/read/write) route execution
 * through `src/sandbox/index.ts`'s Executor directly and never go through
 * this — so a plain host-based env is correct even in sandboxed deployments.
 */
export function createMikanExecutionEnv(cwd: string): ExecutionEnv {
  return new NodeExecutionEnv({ cwd });
}
