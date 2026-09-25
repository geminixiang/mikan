import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AttachmentRejectedError, writeResponseToFile } from "../adapters/shared.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mikan-attachment-download-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("writeResponseToFile", () => {
  test("writes a body within the limit", async () => {
    const destPath = join(directory, "a.txt");

    await writeResponseToFile(new Response("hello"), destPath, 5);

    expect(readFileSync(destPath, "utf8")).toBe("hello");
  });

  test("rejects a declared length over the limit without reading or writing", async () => {
    const destPath = join(directory, "big.bin");
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.close();
      },
    });
    const response = new Response(body, { headers: { "content-length": "6" } });

    await expect(writeResponseToFile(response, destPath, 5)).rejects.toBeInstanceOf(
      AttachmentRejectedError,
    );
    expect(pulled).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  test("stops a streamed body at the limit and removes the partial file", async () => {
    const destPath = join(directory, "stream.bin");
    const response = new Response(streamOf(["abc", "def"]));

    await expect(writeResponseToFile(response, destPath, 5)).rejects.toThrow(
      "exceeds the 5-byte attachment limit",
    );
    expect(existsSync(destPath)).toBe(false);
  });
});
