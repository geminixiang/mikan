import type {
  HarnessBootstrap,
  HarnessCommand,
  HarnessCommandResult,
  HarnessCursor,
  HarnessEventEnvelope,
  HarnessPrincipal,
} from "@geminixiang/mikan-harness-web-contract";
import type { MikanModels } from "../../harness/index.js";
import type { Workspace } from "../../office/index.js";
import type { ConversationRuntime } from "../../runtime/types.js";

export interface HarnessHostOptions {
  workspace: Workspace;
  runtime: ConversationRuntime;
  models: MikanModels;
  stateDir: string;
  now?: () => Date;
  createId?: () => string;
}

export type HarnessSubscription =
  | { kind: "subscribed"; dispose: () => void }
  | { kind: "reset"; cursor: HarnessCursor };

export interface HarnessHost {
  bootstrap(principal: HarnessPrincipal, officeKey?: string): Promise<HarnessBootstrap>;
  execute(principal: HarnessPrincipal, command: HarnessCommand): Promise<HarnessCommandResult>;
  subscribe(
    principal: HarnessPrincipal,
    cursor: HarnessCursor,
    emit: (event: HarnessEventEnvelope) => void,
  ): HarnessSubscription;
}
