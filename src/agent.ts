/**
 * Agent runner public surface. Implementation lives in `src/agent/`.
 */
export type { PiAgentWrapper } from "./types.js";
export { createRunner } from "./agent/runner.js";
export {
  resolveTriggerAttribution,
  buildTurnInstructions,
  appendTriggerAttribution,
} from "./agent/prompt.js";
export { buildPromptPayload } from "./agent/payload.js";
export {
  getUnresolvedSandboxPathContext,
  translateRuntimePathToHost,
  translateAttachPathToHost,
} from "./agent/paths.js";
