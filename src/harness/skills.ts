import { loadSourcedSkills, type ExecutionEnv, type Skill } from "@earendil-works/pi-agent-core";
import { join } from "path";

type SkillSource = "workspace" | "channel";

/**
 * Load workspace-level and conversation-level skills, merged by name with
 * conversation skills overriding workspace skills on collision (matches
 * mikan's original semantics). `filePath` is translated from host paths to
 * the runtime workspace path since it's the only field emitted into the
 * system prompt (via `<location>`).
 */
export async function loadMikanSkills(
  env: ExecutionEnv,
  conversationDir: string,
  workspacePath: string,
): Promise<Skill[]> {
  const hostWorkspacePath = join(conversationDir, "..");
  const translatePath = (hostPath: string): string =>
    hostPath.startsWith(hostWorkspacePath)
      ? workspacePath + hostPath.slice(hostWorkspacePath.length)
      : hostPath;

  const { skills } = await loadSourcedSkills<SkillSource>(env, [
    { path: join(hostWorkspacePath, "skills"), source: "workspace" },
    { path: join(conversationDir, "skills"), source: "channel" },
  ]);

  const skillMap = new Map<string, Skill>();
  for (const { skill } of skills) {
    skillMap.set(skill.name, { ...skill, filePath: translatePath(skill.filePath) });
  }
  return Array.from(skillMap.values());
}
