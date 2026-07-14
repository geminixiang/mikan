import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

const schema = Type.Object({
  prompt: Type.String({ description: "Description of the image to generate" }),
  size: Type.Optional(Type.String({ description: "Requested image size, for example 1024x1024" })),
  quality: Type.Optional(
    Type.String({ description: "Requested image quality, for example low, medium, or high" }),
  ),
});

interface ImageResponse {
  data?: Array<{ b64_json?: string }>;
  error?: { message?: string };
}

export function createGenerateImageTool(options: {
  model: Model<Api>;
  getApiKey: () => Promise<string | undefined>;
  workspaceDir: string;
}): {
  tool: AgentTool<typeof schema>;
  setUploadFunction: (fn: (filePath: string, title?: string) => Promise<void>) => void;
} {
  let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

  return {
    tool: {
      name: "generate_image",
      label: "generate image",
      description:
        "Generate an image with the configured model provider and attach it to the response.",
      parameters: schema,
      execute: async (_toolCallId, params, signal) => {
        if (!uploadFn) throw new Error("Upload function not configured");
        if (!options.model.baseUrl)
          throw new Error("Image generation requires a configured model baseUrl");
        const apiKey = await options.getApiKey();
        if (!apiKey) throw new Error(`No API key configured for ${options.model.provider}`);

        const response = await fetch(
          `${options.model.baseUrl.replace(/\/$/, "")}/images/generations`,
          {
            method: "POST",
            signal,
            headers: {
              ...options.model.headers,
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: options.model.id,
              prompt: params.prompt,
              ...(params.size ? { size: params.size } : {}),
              ...(params.quality ? { quality: params.quality } : {}),
              response_format: "b64_json",
            }),
          },
        );
        const body = (await response.json()) as ImageResponse;
        if (!response.ok) {
          throw new Error(
            body.error?.message ?? `Image generation failed with HTTP ${response.status}`,
          );
        }
        const encoded = body.data?.[0]?.b64_json;
        if (!encoded) throw new Error("Image generation response contained no image");

        const fileName = `generated-${randomUUID()}.png`;
        await writeFile(join(options.workspaceDir, fileName), Buffer.from(encoded, "base64"));
        await uploadFn(fileName, fileName);

        return {
          content: [{ type: "text" as const, text: `Generated and attached image: ${fileName}` }],
          details: { fileName },
        };
      },
    },
    setUploadFunction: (fn) => {
      uploadFn = fn;
    },
  };
}
