import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildPromptPayload } from "../harness/prompt.js";
import { officeKey } from "../office/index.js";
import type { ConversationMessage } from "../types.js";
import { createMountedRuntimePathContext } from "../sandbox/utils.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = join(tmpdir(), `mikan-agent-attachments-${Date.now()}-${Math.random()}`);
  mkdirSync(join(workspaceDir, "C123", "attachments"), { recursive: true });
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeMessage(localPath: string): ConversationMessage {
  return {
    id: "M1",
    address: { platform: "slack", conversationId: "C123" },
    sessionKey: "C123",
    conversationKind: "shared",
    userId: "U1",
    userName: "alice",
    text: "see image",
    attachments: [{ name: "image.png", localPath }],
  };
}

describe("buildPromptPayload", () => {
  test("reads image attachments through runtime-to-host path translation", async () => {
    writeFileSync(join(workspaceDir, "C123", "attachments", "image.png"), "png-bytes");
    const pathContext = createMountedRuntimePathContext(workspaceDir, "/workspace");

    const payload = await buildPromptPayload(
      makeMessage("C123/attachments/image.png"),
      "/workspace",
      pathContext,
      async () => Buffer.from("png-bytes").toString("base64"),
    );

    expect(payload.imageAttachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("png-bytes").toString("base64"),
      },
    ]);
    expect(payload.userMessage).not.toContain("<attachments>");
  });

  test("keeps runtime paths in text for non-image attachments", async () => {
    writeFileSync(join(workspaceDir, "C123", "attachments", "notes.txt"), "hello");
    const pathContext = createMountedRuntimePathContext(workspaceDir, "/workspace");

    const payload = await buildPromptPayload(
      makeMessage("C123/attachments/notes.txt"),
      "/workspace",
      pathContext,
    );

    expect(payload.imageAttachments).toEqual([]);
    expect(payload.userMessage).toContain("/workspace/C123/attachments/notes.txt");
  });

  test("lists an attachment in the conversation's directory by its path from there", async () => {
    const localPath = `${officeKey(makeMessage("").address)}/attachments/notes.txt`;

    const payload = await buildPromptPayload(makeMessage(localPath), "/workspace");

    expect(payload.userMessage).toContain("<attachments>\nattachments/notes.txt\n");
    expect(payload.userMessage).not.toContain("/workspace/");
  });
});
