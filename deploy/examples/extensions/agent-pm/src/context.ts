/**
 * What every pipeline stage is handed. One shape, so a stage's dependencies
 * are visible in its signature rather than reached for through a module
 * global — which is what makes the stages testable without a live mikan.
 */
import type { MikanExtensionApi } from "@geminixiang/mikan";
import type { DatabaseSync } from "node:sqlite";
import type { AgentPmConfig } from "./config.js";

export interface PipelineContext {
  db: DatabaseSync;
  /**
   * The platform surface: notify, fetchHistory, listUsers, subagent. Stages
   * only ever touch Slack through this, so a dry run is a stub object.
   */
  api: MikanExtensionApi;
  config: AgentPmConfig;
  log: (message: string) => void;
}
