import { describe, expect, test, vi } from "vitest";
import {
  CloudBuildLogUnavailableError,
  fetchCloudBuildLog,
  isCloudBuildId,
  projectFromDetailsUrl,
} from "../adapters/github/cloudbuild.js";
import type { GcpTokenProvider } from "../adapters/github/gcp-auth.js";

const BUILD_ID = "12345678-1234-1234-1234-123456789abc";

const tokenProvider = {
  getAccessToken: vi.fn().mockResolvedValue("gcp-token"),
} as unknown as GcpTokenProvider;

describe("cloudbuild helpers", () => {
  test("isCloudBuildId accepts build uuids and rejects other shapes", () => {
    expect(isCloudBuildId(BUILD_ID)).toBe(true);
    expect(isCloudBuildId("42")).toBe(false);
    expect(isCloudBuildId("not-a-uuid")).toBe(false);
  });

  test("projectFromDetailsUrl extracts the project query param", () => {
    expect(
      projectFromDetailsUrl(
        `https://console.cloud.google.com/cloud-build/builds/${BUILD_ID}?project=123456`,
      ),
    ).toBe("123456");
    expect(projectFromDetailsUrl("https://example.com/no-project")).toBeNull();
    expect(projectFromDetailsUrl("not a url")).toBeNull();
    expect(projectFromDetailsUrl(null)).toBeNull();
  });
});

describe("fetchCloudBuildLog", () => {
  test("reads builds.get then the GCS log object", async () => {
    const calls: { url: string; auth?: string }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(url), auth: headers.Authorization });
      if (String(url).includes("cloudbuild.googleapis.com")) {
        return new Response(
          JSON.stringify({ status: "FAILURE", logsBucket: "gs://my-project_cloudbuild" }),
          { status: 200 },
        );
      }
      return new Response("step 1 failed: exit 2", { status: 200 });
    });

    const logText = await fetchCloudBuildLog({
      tokenProvider,
      project: "my-project",
      buildId: BUILD_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(logText).toBe("step 1 failed: exit 2");
    expect(calls[0].url).toBe(
      `https://cloudbuild.googleapis.com/v1/projects/my-project/builds/${BUILD_ID}`,
    );
    expect(calls[0].auth).toBe("Bearer gcp-token");
    expect(calls[1].url).toBe(
      `https://storage.googleapis.com/storage/v1/b/my-project_cloudbuild/o/log-${BUILD_ID}.txt?alt=media`,
    );
  });

  test("handles a logsBucket with a path prefix", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).includes("cloudbuild.googleapis.com")) {
        return new Response(JSON.stringify({ logsBucket: "gs://bucket/logs" }), { status: 200 });
      }
      return new Response("log", { status: 200 });
    });

    await fetchCloudBuildLog({
      tokenProvider,
      project: "p",
      buildId: BUILD_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(calls[1]).toContain(`/b/bucket/o/${encodeURIComponent(`logs/log-${BUILD_ID}.txt`)}`);
  });

  test("degrades to the console url for CLOUD_LOGGING_ONLY builds", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("cloudbuild.googleapis.com")) {
        return new Response(
          JSON.stringify({ status: "FAILURE", logUrl: "https://console/build/1" }),
          { status: 200 },
        );
      }
      throw new Error("unexpected");
    });

    const failure = await fetchCloudBuildLog({
      tokenProvider,
      project: "p",
      buildId: BUILD_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(CloudBuildLogUnavailableError);
    expect((failure as CloudBuildLogUnavailableError).consoleUrl).toBe("https://console/build/1");
    expect((failure as Error).message).toContain("Cloud Logging only");
  });

  test("translates builds.get and GCS failures into IAM guidance", async () => {
    const forbidden = vi.fn(async () => new Response("forbidden", { status: 403 }));
    await expect(
      fetchCloudBuildLog({
        tokenProvider,
        project: "p",
        buildId: BUILD_ID,
        fetchImpl: forbidden as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/cloudbuild\.builds\.viewer/);

    const gcsDenied = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("cloudbuild.googleapis.com")) {
        return new Response(JSON.stringify({ logsBucket: "gs://bucket" }), { status: 200 });
      }
      return new Response("denied", { status: 403 });
    });
    await expect(
      fetchCloudBuildLog({
        tokenProvider,
        project: "p",
        buildId: BUILD_ID,
        fetchImpl: gcsDenied as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/storage\.objectViewer/);
  });
});
