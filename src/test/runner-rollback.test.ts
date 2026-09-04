import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createConfiguredAgentSession: vi.fn(),
  disposeMcp: vi.fn(),
  loadMcpTools: vi.fn(),
}));

vi.mock("../agent/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/catalog.js")>();
  return { ...actual, createConfiguredAgentSession: mocks.createConfiguredAgentSession };
});

vi.mock("../mcp/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/loader.js")>();
  return { ...actual, loadMcpTools: mocks.loadMcpTools };
});

import { createRunner } from "../agent/runner.js";
import { MikanModels } from "../harness/index.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import { officeSessionsDir } from "../office/index.js";
import { createManagedSessionFile } from "../sessions/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mikan-runner-rollback-"));
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({
      llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" },
      sandbox: { workspace: { doorPolicy: "trusted", layout: "full" } },
    }),
  );
  process.env.MIKAN_STATE_DIR = stateDir;
  mocks.disposeMcp.mockReset().mockResolvedValue(undefined);
  mocks.loadMcpTools.mockReset().mockResolvedValue({
    tools: [],
    errors: [],
    instructions: [],
    dispose: mocks.disposeMcp,
  });
  mocks.createConfiguredAgentSession.mockReset();
});

afterEach(() => {
  delete process.env.MIKAN_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function createOptions() {
  const stateDir = join(dir, "state");
  const office = createWorkspace({ root: join(dir, "workspace"), stateDir }).office(
    createOfficeAddress("slack", "C1"),
  );
  const conversationDir = office.ensure();
  const sessionDir = officeSessionsDir(conversationDir);
  const contextFile = createManagedSessionFile(sessionDir, conversationDir);
  const models = MikanModels.create({ modelsJsonPath: join(dir, "models.json") });
  (models.models as MutableModels).setProvider(fauxProvider().provider);
  return {
    sandboxConfig: { type: "host" } as const,
    sessionKey: "C1",
    office,
    trustModel: "membership" as const,
    sessionScope: { sessionDir, contextFile, threadRootMessage: null },
    models,
  };
}

describe("createRunner rollback", () => {
  test("disposes acquired resources and permits immediate reconstruction after failure", async () => {
    const failure = new Error("agent session construction failed");
    mocks.createConfiguredAgentSession.mockRejectedValue(failure);
    const options = createOptions();

    await expect(createRunner(options)).rejects.toBe(failure);
    expect(mocks.disposeMcp).toHaveBeenCalledOnce();

    await expect(createRunner(options)).rejects.toBe(failure);
    expect(mocks.createConfiguredAgentSession).toHaveBeenCalledTimes(2);
    expect(mocks.disposeMcp).toHaveBeenCalledTimes(2);
  });

  test("waits for construction to settle, then rolls back when shutdown aborts", async () => {
    const controller = new AbortController();
    let releaseConstruction!: () => void;
    const constructionGate = new Promise<void>((resolve) => (releaseConstruction = resolve));
    mocks.createConfiguredAgentSession.mockImplementation(async () => {
      await constructionGate;
      return {};
    });
    const options = { ...createOptions(), signal: controller.signal };
    const construction = createRunner(options);
    await vi.waitFor(() => expect(mocks.createConfiguredAgentSession).toHaveBeenCalledOnce());

    const reason = new Error("shutdown");
    controller.abort(reason);
    expect(mocks.disposeMcp).not.toHaveBeenCalled();
    releaseConstruction();

    await expect(construction).rejects.toBe(reason);
    expect(mocks.disposeMcp).toHaveBeenCalledOnce();

    const retryFailure = new Error("retry reached construction");
    mocks.createConfiguredAgentSession.mockRejectedValue(retryFailure);
    await expect(createRunner({ ...options, signal: undefined })).rejects.toBe(retryFailure);
  });

  test("preserves the construction error and releases the writer when MCP cleanup fails", async () => {
    const failure = new Error("agent session construction failed");
    mocks.createConfiguredAgentSession.mockRejectedValue(failure);
    mocks.disposeMcp.mockRejectedValue(new Error("MCP cleanup failed"));
    const options = createOptions();

    await expect(createRunner(options)).rejects.toBe(failure);
    await expect(createRunner(options)).rejects.toBe(failure);

    expect(mocks.createConfiguredAgentSession).toHaveBeenCalledTimes(2);
    expect(mocks.disposeMcp).toHaveBeenCalledTimes(2);
  });
});
