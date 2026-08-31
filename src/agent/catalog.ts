import type { Office } from "../office/index.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai";
import type { MikanModels, MikanSkill, SessionStore } from "../harness/index.js";
import { loadSkillsFromDir, MikanAgentSession } from "../harness/index.js";
import { runSubagent } from "../harness/subagent-runner.js";
import { loadSubagentProfiles } from "../harness/subagent-profiles.js";
import type { WorkspaceProjection } from "../workspace-projection/types.js";
import { packageSkillRuntimeDir } from "../packages/index.js";
import type { ResolvedPackages } from "../packages/types.js";
import * as log from "../log.js";
import type { createMikanTools } from "../tools/index.js";
import { createSubagentTool } from "../tools/index.js";
import { DEFAULT_GLOBAL_SUBAGENT_SLOTS, SubagentSlotPool } from "../harness/subagent-slots.js";

// One process-wide fan-out account: per-conversation queues serialize runs,
// but each run can fan out up to the per-run cap — without this shared
// ceiling, N busy conversations hold N × cap live subagent sessions.
const globalSubagentSlots = new SubagentSlotPool(DEFAULT_GLOBAL_SUBAGENT_SLOTS);

export function loadMikanSkills(
  office: Office,
  workspacePath: string,
  projection: WorkspaceProjection,
  packages: ResolvedPackages,
): { skills: MikanSkill[]; skippedSkillLinks: string[] } {
  const skillMap = new Map<string, MikanSkill>();

  // workspacePath is the runtime-side root (e.g. /workspace); host paths under
  // the workspace root translate onto it for prompt references.
  const hostWorkspacePath = office.workspace.root;
  const translatePath = (hostPath: string): string => {
    if (hostPath.startsWith(hostWorkspacePath)) {
      return workspacePath + hostPath.slice(hostWorkspacePath.length);
    }
    return hostPath;
  };

  // Package skills are lowest precedence. In sandbox modes they are mounted
  // read-only outside the workspace so scripts and templates remain available.
  const mounted = workspacePath !== hostWorkspacePath;
  for (const { slug, dir } of packages.skillDirs) {
    const runtimeDir = packageSkillRuntimeDir(slug);
    for (const skill of loadSkillsFromDir({ dir, source: `package:${slug}` }).skills) {
      if (mounted) {
        skill.filePath = runtimeDir + skill.filePath.slice(dir.length);
        skill.baseDir = runtimeDir + skill.baseDir.slice(dir.length);
      }
      skillMap.set(skill.name, skill);
    }
  }

  const workspaceSkillsDir = projection.promptSources.globalSkillsDir;
  if (workspaceSkillsDir) {
    for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" })
      .skills) {
      skill.filePath = translatePath(skill.filePath);
      skill.baseDir = translatePath(skill.baseDir);
      skillMap.set(skill.name, skill);
    }
  }

  const conversationSkills = loadSkillsFromDir({
    dir: projection.promptSources.conversationSkillsDir,
    source: "channel",
    rejectSymlinks: true,
  });
  const skippedSkillLinks: string[] = [];
  for (const diagnostic of conversationSkills.diagnostics) {
    if (diagnostic.code !== "symlink") continue;
    log.logWarning("Skipping conversation skill entry (symlink)", diagnostic.path);
    skippedSkillLinks.push(translatePath(diagnostic.path));
  }
  for (const skill of conversationSkills.skills) {
    skill.filePath = translatePath(skill.filePath);
    skill.baseDir = translatePath(skill.baseDir);
    skillMap.set(skill.name, skill);
  }

  return { skills: Array.from(skillMap.values()), skippedSkillLinks };
}

export async function createConfiguredAgentSession(params: {
  workspaceDir: string;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMikanTools>>["tools"];
  sessionStore: SessionStore;
  models: MikanModels;
}): Promise<MikanAgentSession> {
  const { workspaceDir, systemPrompt, model, thinkingLevel, tools, sessionStore, models } = params;
  const loadedProfiles = loadSubagentProfiles(workspaceDir);
  for (const diagnostic of loadedProfiles.diagnostics) {
    log.logWarning(`Subagent profile ignored: ${diagnostic.path}`, diagnostic.message);
  }

  const availableToolNames = new Set(tools.map((tool) => tool.name));
  const runnableProfiles = new Map(
    [...loadedProfiles.profiles].filter(([, profile]) =>
      profile.tools.every((tool) => availableToolNames.has(tool)),
    ),
  );
  let session: MikanAgentSession | undefined;
  const subagentTool = createSubagentTool(
    (request, hooks) =>
      runSubagent({
        request,
        ...(hooks?.onActivity ? { onActivity: hooks.onActivity } : {}),
        defaultModel: model,
        thinkingLevel,
        models,
        workspaceDir,
        availableTools: tools,
        profiles: runnableProfiles,
        slots: globalSubagentSlots,
        parentMessages: [...session!.messages],
        onUsage: session!.captureExternalUsageSink(),
      }),
    runnableProfiles,
  );

  session = new MikanAgentSession({
    systemPrompt,
    model,
    thinkingLevel,
    tools: [...tools, subagentTool],
    models,
    sessionStore,
  });
  const reloaded = await session.reloadFromSession();
  if (reloaded > 0) log.logInfo(`Reloaded ${reloaded} messages from session context`);
  return session;
}
