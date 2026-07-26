import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildPromptPayload,
  translateAttachPathToHost,
} from "../src/agent.js";
import type { ConversationMessage } from "../src/adapter.js";
import { createMountedRuntimePathContext } from "../src/sandbox/path-context.js";

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
    sessionKey: "C123",
    conversationKind: "shared",
    userId: "U1",
    userName: "alice",
    text: "see image",
    attachments: [{ name: "image.png", localPath }],
  };
}

describe("buildPromptPayload", () => {
  test("reads image attachments through runtime-to-host path translation", () => {
    writeFileSync(join(workspaceDir, "C123", "attachments", "image.png"), "png-bytes");
    const pathContext = createMountedRuntimePathContext(workspaceDir, "/workspace");

    const payload = buildPromptPayload(
      makeMessage("C123/attachments/image.png"),
      "/workspace",
      pathContext,
    );

    expect(payload.imageAttachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from("png-bytes").toString("base64"),
      },
    ]);
    expect(payload.userMessage).not.toContain("<slack_attachments>");
  });

  test("keeps runtime paths in text for non-image attachments", () => {
    writeFileSync(join(workspaceDir, "C123", "attachments", "notes.txt"), "hello");
    const pathContext = createMountedRuntimePathContext(workspaceDir, "/workspace");

    const payload = buildPromptPayload(
      makeMessage("C123/attachments/notes.txt"),
      "/workspace",
      pathContext,
    );

    expect(payload.imageAttachments).toEqual([]);
    expect(payload.userMessage).toContain("/workspace/C123/attachments/notes.txt");
  });

  test("rejects an existing symlink that points outside the host workspace", () => {
    const linkPath = join(workspaceDir, "C123", "attachments", "secret.txt");
    symlinkSync("/etc/passwd", linkPath);
    const pathContext = createMountedRuntimePathContext(workspaceDir, "/workspace");

    expect(() => translateAttachPathToHost("C123/attachments/secret.txt", pathContext)).toThrow(
      "symlink target is outside",
    );
  });

});
