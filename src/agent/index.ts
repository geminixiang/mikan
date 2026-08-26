/**
 * Agent runner: prompt construction, path translation, run lifecycle, and createRunner.
 * Split by authority; this barrel preserves the former public surface.
 */
export { translateRuntimePathToHost, translateAttachPathToHost } from "./execution.js";
export {
  buildPromptPayload,
  resolveTriggerAttribution,
  buildTurnInstructions,
  appendTriggerAttribution,
} from "./prompt.js";
export { createRunner } from "./runner.js";
export type { PiAgentWrapper } from "../types.js";
