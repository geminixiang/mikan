import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EventStore } from "../events/index.js";
import { createMikanTools } from "../harness/tools/index.js";
import { createOfficeAddress } from "../office/index.js";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ConversationResponder } from "../types.js";
import { runTestTool } from "./tool-api.js";

const address = createOfficeAddress("slack", "C1");
let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function eventStore(): EventStore {
  return {
    address,
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    read: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function boundAttachTool(uploadFile: ConversationResponder["uploadFile"]) {
  root = mkdtempSync(join(tmpdir(), "mikan-bind-run-"));
  const env = new NodeExecutionEnv({ cwd: root });
  const { tools, bindRun } = createMikanTools(() => env, eventStore(), {
    sandbox: { type: "host" },
  });
  bindRun({
    message: { address, conversationKind: "shared", userId: "U1" },
    responder: { uploadFile } as Pick<ConversationResponder, "uploadFile"> as ConversationResponder,
    platformName: "slack",
    runtimeWorkspaceRoot: root,
  });
  const attach = tools.find((tool) => tool.name === "attach");
  if (!attach) throw new Error("attach tool missing");
  return { attach, root };
}

describe("createMikanTools bindRun", () => {
  test("attach uploads a staged copy of a workspace file through the run's responder", async () => {
    let uploaded: { content: string; title?: string } | undefined;
    const { attach, root: workspace } = boundAttachTool(async (path, title) => {
      uploaded = { content: readFileSync(path, "utf8"), title };
    });
    writeFileSync(join(workspace, "report.txt"), "hello");

    await runTestTool(attach, { label: "share", path: "report.txt" });

    expect(uploaded).toEqual({ content: "hello", title: "report.txt" });
  });

  test("attach refuses paths outside the run's workspace", async () => {
    const uploadFile = vi.fn();
    const { attach } = boundAttachTool(uploadFile);

    await expect(runTestTool(attach, { label: "x", path: "../outside.txt" })).rejects.toThrow(
      /parent-directory traversal/,
    );
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
