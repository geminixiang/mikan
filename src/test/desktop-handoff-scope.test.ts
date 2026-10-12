import { describe, expect, test, vi } from "vitest";
import { ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { runTestTool } from "./tool-api.js";
import { createMikanTools } from "../harness/tools/index.js";
import type { EventStore } from "../events/index.js";
import { createOfficeAddress } from "../office/index.js";
import type { ConversationKind, ConversationResponder } from "../types.js";

function eventStore(): EventStore {
  return {
    address: createOfficeAddress("telegram", "-100123"),
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function handOffIn(conversationKind: ConversationKind) {
  const env = new NodeExecutionEnv({ cwd: "/workspace" });
  const exec = vi.spyOn(env, "exec").mockImplementation(async (_command, options, context) => {
    options?.onOutput?.(JSON.stringify({ display: "wayland-1", control: "agent" }), context, {
      stream: "stdout",
    });
    return ok({ exitCode: 0 });
  });
  const desktop = {
    link: vi.fn(() => "https://portal.example/desktop?token=t"),
    open: vi.fn(async () => true),
  };
  const { tools, bindRun } = createMikanTools(
    () => env,
    eventStore(),
    { sandbox: { type: "oci", image: "ghcr.io/example/sandbox:1" } },
    [],
    undefined,
    undefined,
    desktop,
  );
  const respond = vi.fn(async () => {});
  const responder: ConversationResponder = {
    respond,
    replaceResponse: async () => {},
    respondDiagnostic: async () => {},
    respondToolResult: async () => {},
    setTyping: async () => {},
    setWorking: async () => {},
    uploadFile: async () => {},
    deleteResponse: async () => {},
  };
  bindRun({
    message: {
      address: createOfficeAddress("telegram", "-100123"),
      conversationKind,
      userId: "U1",
    },
    responder,
    platformName: "telegram",
    runtimeWorkspaceRoot: "/workspace",
  });
  const browser = tools.find((tool) => tool.name === "jev_browser")!;
  return {
    run: () => runTestTool(browser, { label: "t", handOff: "Sign in" }, { env }),
    exec,
    respond,
    desktop,
  };
}

describe("jev_browser handOff scope", () => {
  test("a shared conversation cannot hand the browser over, and control stays with the agent", async () => {
    const { run, exec, respond, desktop } = handOffIn("shared");

    await expect(run()).rejects.toThrow(/direct message/);

    expect(desktop.open).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(exec.mock.calls.map(([command]) => command)).not.toContainEqual([
      "mikan-desktop",
      "control",
      "user",
    ]);
  });
});
