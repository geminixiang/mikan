import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createGenerateImageTool } from "../src/tools/generate-image.js";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("generate_image tool", () => {
  test("requests an image from the configured model and uploads it", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "mikan-image-test-"));
    dirs.push(workspaceDir);
    const image = Buffer.from("png bytes");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const upload = vi.fn(async () => {});
    const model = {
      id: "gpt-5.6-sol",
      provider: "agent-model",
      baseUrl: "http://127.0.0.1:8080/v1",
    } as Model<Api>;
    const { tool, setUploadFunction } = createGenerateImageTool({
      model,
      getApiKey: async () => "test-token",
      workspaceDir,
    });
    setUploadFunction(upload);

    await tool.execute(
      "call-1",
      { prompt: "a waving robot", size: "1024x1024", quality: "low" },
      undefined,
      undefined,
      undefined as never,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      model: "gpt-5.6-sol",
      prompt: "a waving robot",
      size: "1024x1024",
      quality: "low",
      response_format: "b64_json",
    });
    const [fileName] = upload.mock.calls[0]!;
    expect(await readFile(join(workspaceDir, fileName))).toEqual(image);
  });
});
