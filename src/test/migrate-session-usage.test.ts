import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sessionUsageMigration } from "../migrations/session-usage.js";
import type { MigrationContext } from "../migrations/types.js";
import { OfficeRegistry, createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office } from "../office/types.js";
import { SessionStore } from "../sessions/session-store.js";
import { RUN_CAUSE_CUSTOM_TYPE } from "../sessions/types.js";

let stateDir: string;
let office: Office;
let reports: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "mikan-migrate-usage-"));
  const address = createOfficeAddress("slack", "C1");
  new OfficeRegistry(stateDir).recordOffice(address);
  office = createWorkspace({ root: join(stateDir, "workspace"), stateDir }).office(address);
  reports = [];
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function context(dryRun = false): MigrationContext {
  return {
    workspaceRoot: join(stateDir, "workspace"),
    stateDir,
    dryRun,
    owners: new Map(),
    enabledPlatforms: ["slack"],
    sandbox: { type: "host" },
    piAgentDir: join(stateDir, "pi"),
    modelsPath: join(stateDir, "models.json"),
    docker: async () => "",
    report: (line) => {
      reports.push(line);
    },
  };
}

async function importedAnswer(
  key: string,
  input: number,
  cause?: string,
  withUsage = true,
): Promise<void> {
  const session = await SessionStore.open(office, key);
  if (cause) await session.appendCustomEntry(RUN_CAUSE_CUSTOM_TYPE, { messageId: cause });
  const answer: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "imported answer" }],
    api: "openai-responses",
    provider: "acme",
    model: "acme-1",
    usage: {
      input,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 2,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  if (!withUsage) Reflect.deleteProperty(answer, "usage");
  await session.appendMessage(answer);
  await session.close();
}

async function spentTokens(key: string): Promise<number | undefined> {
  return (await SessionStore.spend(office, key))?.usage.totalTokens;
}

test("records the spend of imported answers once, and only in the session that holds them", async () => {
  await importedAnswer("C1", 10, "1000.1");
  await SessionStore.forkRun(office, "C1:1000.1", { sessionKey: "C1", messageId: "1000.1" }, []);
  expect(await spentTokens("C1")).toBe(0);

  await sessionUsageMigration.run(context(true));
  expect(await spentTokens("C1")).toBe(0);
  expect(reports).toEqual([`  1 sessions -> ${office.sessionsPath}`]);

  await sessionUsageMigration.run(context());
  await sessionUsageMigration.run(context());

  expect(await spentTokens("C1")).toBe(12);
  expect((await SessionStore.spend(office, "C1"))?.usage.cost.total).toBeCloseTo(0.3);
  expect(await spentTokens("C1:1000.1")).toBe(0);
});

test("skips imported answers that recorded no usage", async () => {
  await importedAnswer("C1", 10, undefined, false);
  await importedAnswer("C1", 10);

  await sessionUsageMigration.run(context());

  expect(await spentTokens("C1")).toBe(12);
  expect(await SessionStore.ownResponseUsage(office, "C1")).toHaveLength(1);
});

test("does nothing for an office without session storage", async () => {
  await sessionUsageMigration.run(context());
  expect(reports).toEqual([]);
});
