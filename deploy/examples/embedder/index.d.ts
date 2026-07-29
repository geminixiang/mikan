import { type ConversationRuntime, type MikanModels } from "@geminixiang/mikan";
export interface Embedder {
  runtime: ConversationRuntime;
  /** Run one line of input through the agent; resolves when the run ends. */
  handleLine(line: string): Promise<void>;
}
export declare function createEmbedder(options: {
  workingDir: string;
  /** Host-only state root; defaults to a `state` dir beside the workspace. */
  stateDir?: string;
  models?: MikanModels;
  write?: (text: string) => void;
}): Embedder;
//# sourceMappingURL=index.d.ts.map
