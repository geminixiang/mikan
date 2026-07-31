/**
 * Deployment configuration — the few things that are neither secret nor
 * derivable, held in `config.json` next to the database so an admin can edit
 * them without a redeploy.
 *
 * The load-bearing field is `deliveryMode`. Every outbound message has to be
 * divertible to one test conversation — while a new workflow is being tuned,
 * or while this runs beside whatever it is replacing. `test` is the default
 * precisely because the failure mode of getting it wrong is notifying every
 * team channel, twice.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export interface AgentPmConfig {
  /**
   * The conversation that owns the schedules and receives operational
   * reports. Exactly one conversation may own them; without it the extension
   * activates read-only (tools and commands work, nothing fires on a timer).
   */
  controlConversationId: string;
  /**
   * `test` diverts every delivery to `testConversationId`, prefixed with the
   * channel it would have gone to. `live` sends to the real target.
   */
  deliveryMode: "test" | "live";
  testConversationId: string;
  /** GitHub org for issue and comment ingestion. */
  githubOrg: string;
  /** Google Calendar id carrying the team's leave events. */
  calendarId: string;
  /** Ingestion pauses per source, for turning one feed off without a deploy. */
  disabledSources: string[];
  /**
   * Taipei hour the daily heartbeat fires at, or `null` for the first tick of
   * the day, whichever hour that turns out to be.
   *
   * `null` is the default because a heartbeat pinned to 09:00 tells you
   * nothing if the pipeline happened to be down at 09:00 — you get silence,
   * which is the same thing a healthy-but-quiet system produces. First tick of
   * the day delivers as soon as the pipeline is alive, which is the question a
   * heartbeat is actually asked. Pin an hour when you want it to land at a
   * predictable time for people rather than for monitoring.
   *
   * Read when the workflow row is first seeded — after that the schedule lives
   * in `Workflow.trigger`, because the design keeps "when" in workflow data.
   */
  heartbeatHour: number | null;
  /**
   * Cron overrides per schedule name, e.g. `{"run-workflows": "* * * * *"}`.
   * The defaults suit production; a deployment that wants tighter latency (or
   * an end-to-end check that cannot wait ten minutes) changes them here
   * rather than in code.
   */
  scheduleOverrides: Record<string, string>;
}

const DEFAULTS: AgentPmConfig = {
  controlConversationId: "",
  deliveryMode: "test",
  testConversationId: "",
  githubOrg: "",
  calendarId: "",
  disabledSources: [],
  heartbeatHour: null,
  scheduleOverrides: {},
};

const FILENAME = "config.json";

/**
 * Read `config.json`, filling absent keys from defaults. A malformed file is
 * a hard error rather than a silent fallback to defaults: silently reverting
 * to `deliveryMode: "test"` would look like a working system that has quietly
 * stopped notifying anyone, and silently reverting to `live` is worse.
 */
export function loadConfig(dataDir: string): AgentPmConfig {
  const path = join(dataDir, FILENAME);
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(DEFAULTS, null, 2)}\n`, { mode: 0o600 });
    return { ...DEFAULTS };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`agent-pm config is not valid JSON (${path})`, { cause: err });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`agent-pm config must be a JSON object (${path})`);
  }
  const record = parsed as Record<string, unknown>;
  const mode = record.deliveryMode;
  if (mode !== undefined && mode !== "test" && mode !== "live") {
    throw new Error(`agent-pm config deliveryMode must be "test" or "live" (${path})`);
  }
  return {
    controlConversationId: str(record.controlConversationId) ?? DEFAULTS.controlConversationId,
    deliveryMode: mode ?? DEFAULTS.deliveryMode,
    testConversationId: str(record.testConversationId) ?? DEFAULTS.testConversationId,
    githubOrg: str(record.githubOrg) ?? DEFAULTS.githubOrg,
    calendarId: str(record.calendarId) ?? DEFAULTS.calendarId,
    disabledSources: Array.isArray(record.disabledSources)
      ? record.disabledSources.filter((entry): entry is string => typeof entry === "string")
      : [...DEFAULTS.disabledSources],
    heartbeatHour:
      typeof record.heartbeatHour === "number" &&
      Number.isInteger(record.heartbeatHour) &&
      record.heartbeatHour >= 0 &&
      record.heartbeatHour <= 23
        ? record.heartbeatHour
        : DEFAULTS.heartbeatHour,
    scheduleOverrides: isStringMap(record.scheduleOverrides)
      ? record.scheduleOverrides
      : { ...DEFAULTS.scheduleOverrides },
  };
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

export function saveConfig(dataDir: string, config: AgentPmConfig): void {
  writeFileSync(join(dataDir, FILENAME), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/** Path to the config file, for log lines that tell an admin what to edit. */
export function configPath(dataDir: string): string {
  return join(dataDir, FILENAME);
}

/**
 * Whether this conversation owns the schedules. `activate` runs once per
 * conversation, so without this check every conversation the extension is
 * installed in would register its own copy of the daily jobs and the team
 * would get one digest per conversation.
 */
export function ownsSchedules(config: AgentPmConfig, conversationId: string): boolean {
  return config.controlConversationId !== "" && config.controlConversationId === conversationId;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
