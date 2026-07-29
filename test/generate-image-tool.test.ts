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

const model = {
  id: "gpt-5.6-sol",
  provider: "agent-model",
  baseUrl: "http://127.0.0.1:8080/v1",
} as Model<Api>;

describe("generate_image tool", () => {
  test("writes the image into outputDir and uploads it by host path", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mikan-image-test-"));
    dirs.push(outputDir);
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
    const { tool, setUploadFunction } = createGenerateImageTool({
      model,
      getApiKey: async () => "test-token",
      outputDir,
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
    // The upload callback gets the file's HOST path inside outputDir — not a
    // bare name for the sandbox-staging attach path (that broke when the
    // workspace base stopped being mounted into the guest).
    const [hostPath, title] = upload.mock.calls[0]!;
    expect(hostPath.startsWith(`${outputDir}/generated-`)).toBe(true);
    expect(hostPath.endsWith(".png")).toBe(true);
    expect(title).toBe(hostPath.slice(outputDir.length + 1));
    expect(await readFile(hostPath)).toEqual(image);
  });

  test("surfaces provider errors with the model id that was requested", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "mikan-image-test-"));
    dirs.push(outputDir);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "all deployments and fallbacks exhausted" } }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { tool, setUploadFunction } = createGenerateImageTool({
      model,
      getApiKey: async () => "test-token",
      outputDir,
    });
    setUploadFunction(async () => {});

    await expect(
      tool.execute(
        "call-1",
        { prompt: "a waving robot" },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow(
      'Image generation with model "gpt-5.6-sol" failed: all deployments and fallbacks exhausted',
    );
  });
});
