import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import * as publicApi from "../index.js";

const EXPECTED_RUNTIME_EXPORTS = [
  "CURRENT_SESSION_VERSION",
  "ChatHistorySync",
  "DEFAULT_BUDGET_SETTINGS",
  "DEFAULT_EVENT_BUDGET",
  "DEFAULT_HTTP_IDLE_TIMEOUT_MS",
  "DEFAULT_RETRY_SETTINGS",
  "EXT_ACTION_PREFIX",
  "EventTypeSchema",
  "ExtensionRegistry",
  "MikanAgentSession",
  "MikanModels",
  "SandboxError",
  "SessionStore",
  "buildEventPayload",
  "configureHttpDispatcher",
  "createConversationEvent",
  "createConversationMessage",
  "createConversationRuntime",
  "createExecutor",
  "createManagedSessionFile",
  "createOfficeAddress",
  "createWorkspace",
  "createManagedSessionFileAtPath",
  "createNewSessionFile",
  "defaultCommandHandlers",
  "defaultExtensionDirs",
  "defaultModelsJsonPath",
  "dispatchCommand",
  "extensionSlug",
  "extractSessionSuffix",
  "extractSessionUuid",
  "findV3SessionFiles",
  "formatSkillsForPrompt",
  "officeSessionsDir",
  "getSandboxAdapters",
  "getThreadSessionFile",
  "hasMaterializedChatSession",
  "inferConversationKind",
  "isPlatformHistorySession",
  "isV3SessionFile",
  "listInstalledExtensions",
  "loadExtensions",
  "loadSkillsFromDir",
  "loadSubagentProfiles",
  "migrateSessionFile",
  "namespaceActionIds",
  "officeKey",
  "openManagedSession",
  "parseCommandInput",
  "parseEventPayload",
  "parseExtActionId",
  "parseFrontmatter",
  "parseHttpIdleTimeoutMs",
  "parseSandboxArg",
  "registerThreadSession",
  "resolveChannelSessionFile",
  "resolveChatSessionKey",
  "resolveHarnessSettings",
  "resolveManagedSessionFile",
  "resolveSessionFile",
  "tryResolveCurrentSession",
  "tryResolveThreadSession",
  "validateExtension",
  "validateSandbox",
  "waitForThreadSessionBootstrap",
].toSorted();

describe("public package interface", () => {
  test("changes only through an intentional snapshot update", () => {
    expect(Object.keys(publicApi).toSorted()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  test("snapshots the TypeScript declaration surface", () => {
    const declarations = readFileSync("dist/index.d.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("export "))
      .join("\n");
    expect(declarations).toMatchSnapshot();
  });

  test("declares enforced root and compatibility entry points", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports ?? {}).toSorted()).toEqual([
      ".",
      "./harness",
      "./package.json",
      "./sandbox",
    ]);
  });
});
