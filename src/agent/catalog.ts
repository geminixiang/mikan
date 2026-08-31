import type { OfficeAddress } from "../types.js";
import type { Office, Workspace } from "../office/index.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai";
import type { MikanModels } from "../harness/index.js";
import {
  type ExtensionHostServices,
  type ExtensionScheduleEngine,
  loadExtensions,
  loadSkillsFromDir,
  MikanAgentSession,
  type MikanSkill,
  type SessionStore,
} from "../harness/index.js";
import { runSubagent } from "../harness/subagent-runner.js";
import { loadSubagentProfiles } from "../harness/subagent-profiles.js";
import type {
  PlatformBlockKit,
  PlatformDmOpener,
  PlatformHistoryFetcher,
  PlatformNotifier,
  PlatformReactor,
  PlatformUploader,
  PlatformUserLister,
} from "../types.js";
import type { WorkspaceProjection } from "../workspace-projection/types.js";
import { packageSkillRuntimeDir, resolveConversationPackages } from "../packages/index.js";
import type { ResolvedPackages } from "../packages/types.js";
import * as log from "../log.js";
import type { VaultManager } from "../vault/index.js";
import { HostEventStore } from "../tools/event.js";
import type { createMikanTools } from "../tools/index.js";
import { createSubagentTool } from "../tools/index.js";
import { DEFAULT_GLOBAL_SUBAGENT_SLOTS, SubagentSlotPool } from "../harness/subagent-slots.js";
import type { ConfiguredAgentSession } from "./types.js";

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

  // Helper to translate host paths to container paths
  const translatePath = (hostPath: string): string => {
    if (hostPath.startsWith(hostWorkspacePath)) {
      return workspacePath + hostPath.slice(hostWorkspacePath.length);
    }
    return hostPath;
  };

  // Package skills first: they are the lowest precedence, so a workspace or
  // conversation skill of the same name below overwrites them. A package can
  // offer a capability without taking the name away from whoever wants to
  // replace it locally.
  //
  // Unlike extension-shipped skills, these are NOT inlined into the prompt:
  // conversationPackageSkillMounts exposes them read-only at a runtime path,
  // so the agent can read the files — including any scripts or templates the
  // skill ships alongside its SKILL.md, which inlining could never carry.
  const mounted = workspacePath !== hostWorkspacePath;
  for (const { slug, dir } of packages.skillDirs) {
    const runtimeDir = packageSkillRuntimeDir(slug);
    for (const skill of loadSkillsFromDir({ dir, source: `package:${slug}` }).skills) {
      // In host mode there is no mount, so the host path is already the path
      // the agent will use.
      if (mounted) {
        skill.filePath = runtimeDir + skill.filePath.slice(dir.length);
        skill.baseDir = runtimeDir + skill.baseDir.slice(dir.length);
      }
      skillMap.set(skill.name, skill);
    }
  }

  // Load workspace-level skills only when the office projection authorizes it.
  const workspaceSkillsDir = projection.promptSources.globalSkillsDir;
  if (workspaceSkillsDir) {
    for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" })
      .skills) {
      skill.filePath = translatePath(skill.filePath);
      skill.baseDir = translatePath(skill.baseDir);
      skillMap.set(skill.name, skill);
    }
  }

  // Load conversation-specific skills (override workspace skills on collision).
  // Host prompt construction must never follow an agent-created symlink out of
  // the conversation office, so this load rejects symlinks per entry — on
  // exactly the paths it reads. Vendored node_modules and dot directories are
  // never read and never disqualify anything.
  const conversationSkillsDir = projection.promptSources.conversationSkillsDir;
  const conversationSkills = loadSkillsFromDir({
    dir: conversationSkillsDir,
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

export function mergeExtensionSkills(local: MikanSkill[], extension: MikanSkill[]): MikanSkill[] {
  if (extension.length === 0) return local;
  const byName = new Map<string, MikanSkill>();
  for (const skill of extension) byName.set(skill.name, skill);
  for (const skill of local) byName.set(skill.name, skill);
  return [...byName.values()];
}

function buildExtensionHostServices(params: {
  workspace: Workspace;
  address: OfficeAddress;
  vaultManager?: VaultManager;
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
  platformUploader?: PlatformUploader;
  platformBlockKit?: PlatformBlockKit;
  platformDmOpener?: PlatformDmOpener;
  platformHistoryFetcher?: PlatformHistoryFetcher;
  platformUserLister?: PlatformUserLister;
  extensionScheduleEngine?: ExtensionScheduleEngine;
  runSubagentService?: ExtensionHostServices["runSubagent"];
}): ExtensionHostServices {
  const {
    workspace,
    address,
    vaultManager,
    platformNotifier,
    platformReactor,
    platformUploader,
    platformBlockKit,
    platformDmOpener,
    platformHistoryFetcher,
    platformUserLister,
    extensionScheduleEngine,
    runSubagentService,
  } = params;
  const eventStore = HostEventStore.fromWorkspaceDir(workspace.root);
  return {
    stateDir: workspace.stateDir,
    scheduleStore: {
      write: async (filename, payload) => {
        await eventStore.write(filename, payload);
      },
      delete: async (filename) => (await eventStore.delete(filename)).deleted,
      list: async () =>
        (await eventStore.list()).flatMap((entry) =>
          entry.payload ? [{ filename: entry.filename, payload: entry.payload }] : [],
        ),
    },
    ...(platformNotifier ? { postMessage: platformNotifier } : {}),
    ...(platformReactor ? { addReaction: platformReactor } : {}),
    ...(platformUploader ? { uploadFile: platformUploader } : {}),
    ...(platformDmOpener ? { openDirectConversation: platformDmOpener } : {}),
    ...(platformHistoryFetcher ? { fetchHistory: platformHistoryFetcher } : {}),
    ...(platformUserLister ? { listUsers: platformUserLister } : {}),
    ...(extensionScheduleEngine
      ? {
          callbackScheduleStore: {
            upsert: (slug, name, spec) => extensionScheduleEngine.upsert(address, slug, name, spec),
            delete: (slug, name) => extensionScheduleEngine.delete(address, slug, name),
            list: (slug) => extensionScheduleEngine.list(address, slug),
          },
        }
      : {}),
    ...(platformBlockKit
      ? { postBlocks: platformBlockKit.postBlocks, updateBlocks: platformBlockKit.updateBlocks }
      : {}),
    ...(runSubagentService ? { runSubagent: runSubagentService } : {}),
    ...(vaultManager
      ? {
          resolveSecrets: (slug: string) => vaultManager.resolve(`extensions/${slug}`)?.env ?? {},
        }
      : {}),
  };
}

export async function createConfiguredAgentSession(params: {
  office: Office;
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: Awaited<ReturnType<typeof createMikanTools>>["tools"];
  sessionStore: SessionStore;
  models: MikanModels;
  vaultManager?: VaultManager;
  platformNotifier?: PlatformNotifier;
  platformReactor?: PlatformReactor;
  platformUploader?: PlatformUploader;
  platformBlockKit?: PlatformBlockKit;
  platformDmOpener?: PlatformDmOpener;
  platformHistoryFetcher?: PlatformHistoryFetcher;
  platformUserLister?: PlatformUserLister;
  extensionScheduleEngine?: ExtensionScheduleEngine;
}): Promise<ConfiguredAgentSession> {
  const {
    office,
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    sessionStore,
    models,
    vaultManager,
    platformNotifier,
    platformReactor,
    platformUploader,
    platformBlockKit,
    platformDmOpener,
    platformHistoryFetcher,
    platformUserLister,
    extensionScheduleEngine,
  } = params;
  const { address } = office;
  const conversationId = address.conversationId;
  const workspaceDir = office.workspace.root;

  // Host-only dirs under the state dir: extension code runs in the mikan
  // process, so it must never load from workspace paths — those are mounted
  // into sandbox containers and agent-writable (sandbox escape otherwise).
  // resolveConversationPackages only ever returns state-dir paths (and host
  // paths an administrator named explicitly in settings); it never reaches
  // the network on this path, so a slow remote cannot delay a reply.
  let session: MikanAgentSession | undefined;
  const loadedProfiles = loadSubagentProfiles(workspaceDir);
  for (const diagnostic of loadedProfiles.diagnostics) {
    log.logWarning(
      `[${conversationId}] Subagent profile ignored: ${diagnostic.path}`,
      diagnostic.message,
    );
  }
  // Narrowed to the profiles whose tools actually exist once extensions have
  // contributed theirs. Both subagent entry points read this at call time, so
  // they always agree on which profiles are launchable.
  let runnableSubagentProfiles = loadedProfiles.profiles;
  const resolvedPackages = resolveConversationPackages({ office });
  for (const error of resolvedPackages.errors) {
    log.logWarning(`Package unavailable: ${error.source}`, error.message);
  }
  const extensionsResult = await loadExtensions({
    dirs: resolvedPackages.extensionDirs,
    roots: resolvedPackages.extensionRoots,
    context: { address, conversationId, workspaceDir, model, thinkingLevel },
    services: buildExtensionHostServices({
      workspace: office.workspace,
      address,
      vaultManager,
      platformNotifier,
      platformReactor,
      platformUploader,
      platformBlockKit,
      platformDmOpener,
      platformHistoryFetcher,
      platformUserLister,
      extensionScheduleEngine,
      runSubagentService: (request, extensionTools) => {
        const activeParent = session?.isActiveRun ? session : undefined;
        return runSubagent({
          request,
          defaultModel: model,
          thinkingLevel,
          models,
          workspaceDir,
          availableTools: [...tools, ...extensionTools],
          profiles: runnableSubagentProfiles,
          slots: globalSubagentSlots,
          ...(activeParent
            ? {
                parentMessages: [...activeParent.messages],
                onUsage: activeParent.captureExternalUsageSink(),
              }
            : {}),
        });
      },
    }),
  });
  const contributedTools = extensionsResult.registry.getContributedTools();
  const subagentAvailableTools = [...tools, ...contributedTools];
  const availableToolNames = new Set(subagentAvailableTools.map((tool) => tool.name));
  runnableSubagentProfiles = new Map(
    [...loadedProfiles.profiles].filter(([, profile]) =>
      profile.tools.every((tool) => availableToolNames.has(tool)),
    ),
  );
  for (const err of extensionsResult.errors) {
    log.logWarning(`[${conversationId}] Extension load error: ${err.path}`, err.error);
  }
  if (extensionsResult.extensions.length > 0) {
    log.logInfo(
      `[${conversationId}] Loaded ${extensionsResult.extensions.length} extension(s): ${extensionsResult.extensions.map((extension) => extension.name).join(", ")}`,
    );
  }

  const subagentTool = createSubagentTool(
    (request, hooks) =>
      runSubagent({
        request,
        ...(hooks?.onActivity ? { onActivity: hooks.onActivity } : {}),
        defaultModel: model,
        thinkingLevel,
        models,
        workspaceDir,
        availableTools: subagentAvailableTools,
        profiles: runnableSubagentProfiles,
        slots: globalSubagentSlots,
        parentMessages: [...session!.messages],
        onUsage: session!.captureExternalUsageSink(),
      }),
    runnableSubagentProfiles,
  );

  session = new MikanAgentSession({
    systemPrompt,
    model,
    thinkingLevel,
    tools: [...tools, subagentTool],
    models,
    sessionStore,
    extensions: extensionsResult.registry,
  });

  const activeSession = session;
  const reloaded = await activeSession.reloadFromSession();
  if (reloaded > 0) {
    log.logInfo(`[${conversationId}] Reloaded ${reloaded} messages from session context`);
  }
  return {
    session: activeSession,
    extensionSkills: extensionsResult.skills,
    extensionRegistry: extensionsResult.registry,
    disposeExtensions: extensionsResult.dispose,
  };
}
