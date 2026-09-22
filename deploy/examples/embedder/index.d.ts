import { type ConversationRuntime, type MikanModels } from "@geminixiang/mikan";
export interface Embedder {
  runtime: ConversationRuntime;
  handleLine(line: string): Promise<void>;
}
export declare function createEmbedder(options: {
  workingDir: string;
  stateDir?: string;
  models?: MikanModels;
  write?: (text: string) => void;
}): Embedder;
