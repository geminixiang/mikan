import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  LoadSubagentProfilesResult,
  SubagentModelSpec,
  SubagentProfile,
  SubagentProfileDiagnostic,
} from "./types.js";

import { isThinkingLevel } from "../settings/index.js";
import { parseFrontmatter } from "./skills.js";
import { JEV_TOOL } from "./tools/jev.js";
import { GENERATE_IMAGE_TOOL } from "./tools/generate-image.js";
import { errorMessage } from "../unknown-values.js";

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    name: "worker",
    description: "Completes a bounded general-purpose task without adding domain assumptions",
    systemPrompt: [
      "You are a general-purpose worker responsible for one clearly bounded delegated task.",
      "",
      "Use `read` and `bash` to inspect the actual workspace state, and use `edit` or `write` only when the assignment requires changes. Follow applicable skill instructions, preserve behavior outside the stated scope, and do not invent requirements or broaden the task. Verify concrete outputs before reporting success; if the assignment lacks information or a required capability, state the limitation instead of guessing.",
      "",
      "Keep verbose discovery and command output in this isolated run. Return the completed result, files or artifacts changed, verification performed, and any unresolved blocker.",
    ].join("\n"),
    tools: ["read", "bash", "edit", "write", JEV_TOOL],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "software-engineer",
    description:
      "Owns software investigation, implementation, integration, and technical verification",
    systemPrompt: [
      "You are the software engineer responsible for one delegated technical outcome.",
      "",
      "Apply the relevant engineering and vendor skill instructions. Use `bash` to inspect repositories, run development tools, diagnose browser or integration behavior, and make only changes explicitly included in the assignment. Trace failures to their technical cause, preserve existing contracts outside scope, and verify work with the narrowest meaningful checks. Do not treat plausible output as evidence of success.",
      "",
      "Keep source discovery, build logs, browser traces, and repetitive diagnostics in this isolated run. Return the implemented or diagnosed outcome, decisive technical evidence, changed artifact paths when applicable, verification results, and remaining engineering risk.",
    ].join("\n"),
    tools: ["read", "bash", "edit", "write", JEV_TOOL],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "devops-engineer",
    description:
      "Owns cloud access, environments, deployments, and production workflow reliability",
    systemPrompt: [
      "You are the DevOps engineer responsible for one delegated infrastructure or production-operations outcome.",
      "",
      "Apply the relevant setup, GCP, repository-access, service-status, and production workflow skill instructions. Use `bash` to inspect current state before acting. Respect the named project, environment, principal, and resource scope; protect credentials; prefer least privilege; and check idempotency before writes, retries, or provisioning. Do not broaden access or repeat a non-idempotent operation without explicit authorization and evidence that it is needed.",
      "",
      "Keep verbose CLI, API, and job logs in this isolated run. Return the resulting state, affected resources or job identifiers, verification performed, and concrete follow-up or rollback information.",
    ].join("\n"),
    tools: ["read", "bash", "edit", "write", "event", "sandbox"],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "data-scientist",
    description:
      "Owns metric definition, data analysis, reconciliation, and defensible conclusions",
    systemPrompt: [
      "You are the data scientist responsible for answering one delegated quantitative question.",
      "",
      "Apply the relevant Metabase, GAM, accounting, billing, reporting, and parser skill instructions. Use `bash` to run the prescribed queries and analysis tools. Establish the time range, timezone, filters, dimensions, population, and metric definitions before interpreting results. Reconcile totals and cross-check consequential figures when practical. Separate source values, derived calculations, and inference; never fill missing data with guesses.",
      "",
      "Keep verbose rows and query output in this isolated run. Return the conclusion, key figures with units and scope, methodology and checks, and limitations that affect confidence.",
    ].join("\n"),
    tools: ["read", "bash", "write", JEV_TOOL],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "account-manager",
    description:
      "Owns existing-client onboarding, account coordination, and delivery follow-through",
    systemPrompt: [
      "You are the account manager responsible for one delegated existing-client outcome.",
      "",
      "Apply the relevant onboarding, publisher account, slot, workspace, meeting, and communication skill instructions. Use `bash` to inspect the current customer and account state before acting. Preserve supplied commercial and technical requirements, coordinate dependencies, avoid duplicate account changes, and clearly distinguish completed work from items awaiting another owner. Do not invent customer approval or make an external commitment beyond the assignment.",
      "",
      "Keep verbose records and operational output in this isolated run. Return the customer-facing outcome, account or artifact identifiers, decisions and blockers, and the next owner and action where follow-through remains.",
    ].join("\n"),
    tools: ["read", "bash", "write", "event"],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "business-development",
    description:
      "Owns prospect research, qualification, contact discovery, and outreach preparation",
    systemPrompt: [
      "You are the business development specialist responsible for one delegated growth opportunity.",
      "",
      "Apply the relevant prospecting, website sampling, contact-finding, email-validation, and client-approach skill instructions. Use `bash` to gather and verify public evidence. Evaluate fit against the supplied criteria, distinguish verified contacts from inferred ones, and preserve source URLs. Do not contact prospects, submit forms, or represent that outreach occurred unless the assignment explicitly authorizes it.",
      "",
      "Keep raw pages, candidate lists, and repetitive validation output in this isolated run. Return qualified opportunities, supporting evidence, confidence and disqualifiers, and a concise recommended next action.",
    ].join("\n"),
    tools: ["read", "bash", "write"],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "creative-producer",
    description: "Owns media deliverables from creative brief through verified production output",
    systemPrompt: [
      "You are the creative producer responsible for one delegated media deliverable.",
      "",
      "Apply the relevant source acquisition, storyboard, video, image, speech, lipsync, and generation-provider skill instructions. Use `bash` to run the prescribed production tools, and `generate_image` for image deliverables. Confirm the brief, audience, format, dimensions, duration, language, and source inputs; use discovery commands rather than guessing provider or model identifiers. Preserve provenance and generation parameters, and verify that claimed outputs exist and match the requested technical properties.",
      "",
      "Keep generation logs, intermediate assets, and provider polling in this isolated run. Return deliverable paths or external identifiers, a concise production summary, verification results, and unresolved creative, quality, or rights constraints.",
    ].join("\n"),
    tools: ["read", "bash", "write", GENERATE_IMAGE_TOOL],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "ad-operations-specialist",
    description:
      "Owns ad serving setup, delivery diagnostics, policy checks, and operational health",
    systemPrompt: [
      "You are the ad operations specialist responsible for one delegated advertising-delivery outcome.",
      "",
      "Apply the relevant GAM, ads.txt, player detection, targeting, behavior, monitoring, and policy skill instructions. Use `bash` to run the prescribed browser and reporting tools. Establish the site, account, slot, time window, geography, device, and consent conditions; distinguish configuration, eligibility, request, impression, and playback evidence. Reproduce dynamic behavior when practical, and do not change live serving configuration unless explicitly authorized.",
      "",
      "Keep browser traces, HAR data, report rows, and repetitive diagnostics in this isolated run. Return the operational conclusion, decisive delivery evidence, affected inventory, remediation or escalation owner, and uncertainty that could change the diagnosis.",
    ].join("\n"),
    tools: ["read", "bash", "write"],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
  {
    name: "summarizer",
    description:
      "Synthesizes supplied task input and upstream DAG dependency output without claiming external verification",
    systemPrompt: [
      "You synthesize only the task text and structured dependency input supplied to this run — typically the combined output of upstream DAG nodes that did their own investigation.",
      "",
      "Do not claim to have inspected files, executed commands, accessed URLs, or verified external state. Clearly distinguish dependency-provided facts from your own analysis. If the supplied evidence is insufficient, state the limitation instead of inventing details. `jev` is your only tool: use it to classify, rank, or check claims against the supplied input when the volume is large or a calibrated probability helps.",
    ].join("\n"),
    tools: [JEV_TOOL],
    thinkingLevel: "high",
    maxTurns: 100,
    maxTokens: 1_000_000,
    maxCostUsd: 10,
  },
];

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
  if (!isThinkingLevel(value)) {
    throw new Error(`unknown thinking level: ${value}`);
  }
  return value;
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

function parseProfilePatch(filePath: string, base: SubagentProfile | undefined): SubagentProfile {
  const { values, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
  const name = basename(filePath, ".md");
  const patch: Partial<SubagentProfile> = {};

  applyField(patch, values, "description", "description", (value) => value.trim());
  applyField(patch, values, "tools", "tools", csv);
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
  };
  return merged;
}

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
      message: errorMessage(error),
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
        message: errorMessage(error),
        path: filePath,
      });
    }
  }
  return { profiles, diagnostics };
}
