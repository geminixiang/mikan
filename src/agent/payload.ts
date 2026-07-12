import type { ImageContent } from "@earendil-works/pi-ai";
import type { ConversationMessage } from "../adapter.js";
import type { MikanAgentSession } from "../harness/index.js";
import type { RuntimePathContext } from "../sandbox/index.js";
import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { formatLocalTimestamp } from "../utils/date.js";

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
  return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function formatTimestampedUserMessage(message: ConversationMessage): string {
  const timestamp = formatLocalTimestamp(new Date())!;
  const threadContext = message.threadTs ? ` [in-thread:${message.threadTs}]` : "";
  return `[${timestamp}] [${message.userName || "unknown"}]${threadContext}: ${message.text}`;
}

function collectMessageAttachments(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
): { imageAttachments: ImageContent[]; nonImagePaths: string[] } {
  const imageAttachments: ImageContent[] = [];
  const nonImagePaths: string[] = [];

  for (const attachment of message.attachments || []) {
    const runtimePath = `${workspacePath}/${attachment.localPath}`;
    const hostPath = pathContext?.runtimeToHostPath?.(runtimePath) ?? runtimePath;
    const mimeType = getImageMimeType(attachment.localPath);

    if (mimeType && existsSync(hostPath)) {
      try {
        imageAttachments.push({
          type: "image",
          mimeType,
          data: readFileSync(hostPath).toString("base64"),
        });
      } catch {
        nonImagePaths.push(runtimePath);
      }
    } else {
      nonImagePaths.push(runtimePath);
    }
  }

  return { imageAttachments, nonImagePaths };
}

export function buildPromptPayload(
  message: ConversationMessage,
  workspacePath: string,
  pathContext?: RuntimePathContext,
): {
  userMessage: string;
  imageAttachments: ImageContent[];
} {
  let userMessage = formatTimestampedUserMessage(message);
  const { imageAttachments, nonImagePaths } = collectMessageAttachments(
    message,
    workspacePath,
    pathContext,
  );

  if (nonImagePaths.length > 0) {
    userMessage += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
  }

  return { userMessage, imageAttachments };
}

export async function writePromptDebugContext(
  conversationDir: string,
  systemPrompt: string,
  session: MikanAgentSession,
  userMessage: string,
  imageAttachmentCount: number,
): Promise<void> {
  const debugContext = {
    systemPrompt,
    messages: session.messages,
    newUserMessage: userMessage,
    imageAttachmentCount,
  };
  await writeFile(
    join(conversationDir, "last_prompt.jsonl"),
    JSON.stringify(debugContext, null, 2),
  );
}
