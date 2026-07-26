/**
 * Subagent profiles: the curated capability sets a subagent may be launched
 * with.
 *
 * Profiles exist because the two halves of a subagent definition have
 * different owners. What a profile *does* — its tools, required evidence,
 * prompt and budget — is portable, so it ships as a built-in below and is
 * versioned with the code. Which model runs it is per-installation, so it is
 * overridden by `<workspaceDir>/agents/<name>.md`.
 *
 * A workspace file therefore *patches* the built-in of the same name rather
 * than replacing it: overriding only `model:` must not force an operator to
 * restate the tools and prompt, because a restated copy silently drifts from
 * the built-in it was cloned from. A file whose name matches no built-in
 * defines a new profile and must supply `tools` itself.
 *
 * A malformed file is reported as a diagnostic and skipped, never thrown:
 * these are hand-edited, and one typo must not take the whole workspace down.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  LoadSubagentProfilesResult,
  SubagentModelSpec,
  SubagentProfile,
  SubagentProfileDiagnostic,
} from "./types.js";

export type { LoadSubagentProfilesResult, SubagentProfileDiagnostic } from "./types.js";
import { parseFrontmatter } from "./skills.js";

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "repository-cloner",
    description: "Clones a repository into an explicitly assigned workspace path",
    systemPrompt: [
      "You perform one repository clone task.",
      "",
      "Use the `bash` tool to execute the requested `git clone` command. Before cloning, confirm that the destination is inside the assigned workspace. Never simulate shell output or claim success without a successful tool result. Return the actual destination and a concise command result.",
    ].join("\n"),
    tools: ["bash"],
    requiredTools: ["bash"],
    thinkingLevel: "medium",
    maxTurns: 5,
  },
  {
    name: "repository-researcher",
    description: "Clones a repository, then reads and inspects it with workspace evidence",
    systemPrompt: [
      "You perform a repository clone and evidence-based exploration.",
      "",
      "Use `bash` to clone the requested repository and inspect directory structure. Use `read` for README and other file contents. Every factual claim must be supported by actual tool results. Never simulate command output, file contents, dependencies, or architecture.",
    ].join("\n"),
    tools: ["bash", "read"],
    requiredTools: ["bash", "read"],
    thinkingLevel: "high",
    maxTurns: 12,
  },
  {
    name: "repository-explorer",
    description: "Reads repository files and verifies findings with workspace evidence",
    systemPrompt: [
      "You are a read-only repository explorer.",
      "",
      "Use `read` for file contents and `bash` only for read-only directory or version-control inspection. Every factual claim about the repository must be supported by an actual tool result. Never invent files, command output, dependencies, or architecture.",
      "",
      "Return concise findings with file paths and evidence.",
    ].join("\n"),
    tools: ["read", "bash"],
    requiredTools: ["read"],
    thinkingLevel: "high",
    maxTurns: 20,
  },
  {
    name: "analysis-only",
    description: "Analyzes supplied task input without claiming external verification",
    systemPrompt: [
      "You analyze only the task text and structured dependency input supplied to this run.",
      "",
      "Do not claim to have inspected files, executed commands, accessed URLs, or verified external state. Clearly distinguish dependency-provided facts from your own analysis. If the supplied evidence is insufficient, state the limitation instead of inventing details.",
    ].join("\n"),
    tools: [],
    requiredTools: [],
    thinkingLevel: "high",
    maxTurns: 20,
  },
];

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

/** Parse a comma-separated tool list. The literal `none` is an empty grant. */
function csv(value: string): string[] {
  if (value.trim() === "none") return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseModel(value: string): SubagentModelSpec {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`model must be provider/id, got ${value}`);
  }
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

function parseThinking(value: string): ThinkingLevel {
  if (!THINKING_LEVELS.has(value as ThinkingLevel)) {
    throw new Error(`unknown thinking level: ${value}`);
  }
  return value as ThinkingLevel;
}

function parsePositiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return parsed;
}

/** Apply `field` from frontmatter onto `patch` only when the file sets it. */
function applyField<K extends keyof SubagentProfile>(
  patch: Partial<SubagentProfile>,
  values: Record<string, string>,
  key: string,
  field: K,
  parse: (value: string) => SubagentProfile[K],
): void {
  const raw = values[key];
  if (raw === undefined) return;
  patch[field] = parse(raw);
}

/**
 * Build the overlay a single file contributes. Throws with a human-readable
 * message on malformed input; the caller turns that into a diagnostic.
 */
function parseProfilePatch(filePath: string, base: SubagentProfile | undefined): SubagentProfile {
  const { values, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
  const name = basename(filePath, ".md");
  const patch: Partial<SubagentProfile> = {};

  applyField(patch, values, "description", "description", (value) => value.trim());
  applyField(patch, values, "tools", "tools", csv);
  applyField(patch, values, "required_tools", "requiredTools", csv);
  applyField(patch, values, "model", "model", parseModel);
  applyField(patch, values, "thinking", "thinkingLevel", parseThinking);
  applyField(patch, values, "max_turns", "maxTurns", (v) => parsePositiveInteger(v, "max_turns"));
  applyField(patch, values, "max_tokens", "maxTokens", (v) =>
    parsePositiveInteger(v, "max_tokens"),
  );
  applyField(patch, values, "max_cost_usd", "maxCostUsd", (v) =>
    parseNonNegativeNumber(v, "max_cost_usd"),
  );
  applyField(patch, values, "max_duration_ms", "maxDurationMs", (v) =>
    parsePositiveInteger(v, "max_duration_ms"),
  );

  const systemPrompt = body.trim() || base?.systemPrompt;
  if (!base && patch.tools === undefined) {
    throw new Error(`tools is required for a new profile (no built-in named ${name})`);
  }
  if (!systemPrompt) {
    throw new Error(`a new profile needs prompt text in the file body`);
  }

  const merged: SubagentProfile = {
    ...base,
    ...patch,
    name,
    description: patch.description || base?.description || name,
    systemPrompt,
    tools: patch.tools ?? base?.tools ?? [],
    requiredTools: patch.requiredTools ?? base?.requiredTools ?? [],
  };

  const ungranted = merged.requiredTools.filter((tool) => !merged.tools.includes(tool));
  if (ungranted.length > 0) {
    throw new Error(`required_tools must be included in tools: ${ungranted.join(", ")}`);
  }
  return merged;
}

/**
 * Load the built-in profiles, then patch them with `<workspaceDir>/agents/*.md`.
 * Malformed files are reported and skipped, leaving the built-in in place.
 */
export function loadSubagentProfiles(workspaceDir: string): LoadSubagentProfilesResult {
  const dir = join(workspaceDir, "agents");
  const profiles = new Map(BUILTIN_PROFILES.map((profile) => [profile.name, profile]));
  const diagnostics: SubagentProfileDiagnostic[] = [];
  if (!existsSync(dir)) return { profiles, diagnostics };

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      type: "warning",
      message: error instanceof Error ? error.message : String(error),
      path: dir,
    });
    return { profiles, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      const profile = parseProfilePatch(filePath, profiles.get(basename(entry.name, ".md")));
      profiles.set(profile.name, profile);
    } catch (error) {
      diagnostics.push({
        type: "warning",
        message: error instanceof Error ? error.message : String(error),
        path: filePath,
      });
    }
  }
  return { profiles, diagnostics };
}
