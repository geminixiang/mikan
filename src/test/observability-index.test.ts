import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  shutdownOpenTelemetry: vi.fn<() => Promise<void>>(),
  closeSentry: vi.fn<(timeoutMs: number) => Promise<boolean>>(),
}));

vi.mock("../observability/otel.js", () => ({
  isOpenTelemetryMetricsEnabled: () => false,
  shutdownOpenTelemetry: mocks.shutdownOpenTelemetry,
}));

vi.mock("../observability/sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../observability/sentry.js")>()),
  addSentryBreadcrumb: vi.fn(),
  captureSentryError: vi.fn(),
  closeSentry: mocks.closeSentry,
  recordSentryCounter: vi.fn(),
  recordSentryDistribution: vi.fn(),
  recordSentryGauge: vi.fn(),
  withSentryRunScope: <T>(_context: unknown, body: () => T): T => body(),
}));

import {
  createRunAttributionAttributes,
  metricAttributes,
  shutdownObservability,
  telemetryIdentifier,
} from "../observability/index.js";

afterEach(() => vi.unstubAllEnvs());

describe("vendor-neutral observability privacy", () => {
  test("emits content-free standard GenAI and Phoenix attribution", () => {
    const attributes = createRunAttributionAttributes({
      conversationId: "C123",
      sessionKey: "session-1",
      messageId: "message-1",
      platform: "slack",
      userId: "user-1",
      provider: "anthropic",
      model: "claude",
    });

    expect(attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "mikan",
      "gen_ai.conversation.id": telemetryIdentifier("session", "session-1"),
      "openinference.span.kind": "AGENT",
      "session.id": telemetryIdentifier("session", "session-1"),
    });
    expect(Object.keys(attributes)).not.toEqual(
      expect.arrayContaining([
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "gen_ai.system_instructions",
        "input.value",
        "output.value",
      ]),
    );
  });

  test("uses a deployment key for stable opaque identifiers", () => {
    vi.stubEnv("TELEMETRY_HASH_KEY", "deployment-secret");
    const first = telemetryIdentifier("conv", "C123");
    expect(first).toBe(telemetryIdentifier("conv", "C123"));
    expect(first).not.toContain("C123");
    expect(first).not.toBe(telemetryIdentifier("user", "C123"));
  });

  test("sanitizes sensitive keys, credentials, and absolute paths before recording", () => {
    expect(
      metricAttributes({
        prompt: "private prompt",
        tool_args: "do not export",
        api_token: "sk-abcdefghijklmnop",
        failure: "failed at /Users/alice/private/file.ts with ghp_abcdefghijklmnopqrstuv",
        linux_failure: "failed at /home/alice/private/file.ts",
        url: "https://collector.example/v1/traces",
        provider: "anthropic",
        omitted: undefined,
      }),
    ).toEqual({
      prompt: "[Redacted prompt; length=14]",
      tool_args: "[Redacted tool_args; length=13]",
      api_token: "[Redacted api_token; length=19]",
      failure: "failed at [REDACTED_PATH] with [REDACTED]",
      linux_failure: "failed at [REDACTED_PATH]",
      url: "[Redacted url; length=35]",
      provider: "anthropic",
    });
  });
});

describe("observability shutdown", () => {
  beforeEach(() => {
    mocks.order.length = 0;
    mocks.shutdownOpenTelemetry.mockReset().mockImplementation(async () => {
      mocks.order.push("otel");
    });
    mocks.closeSentry.mockReset().mockImplementation(async () => {
      mocks.order.push("sentry");
      return true;
    });
  });

  test("shuts down OpenTelemetry before closing Sentry", async () => {
    await expect(shutdownObservability(5_000)).resolves.toBe(true);
    expect(mocks.order).toEqual(["otel", "sentry"]);
    expect(mocks.closeSentry).toHaveBeenCalledWith(5_000);
  });

  test("still closes Sentry when OpenTelemetry shutdown fails", async () => {
    const failure = new Error("collector unavailable");
    mocks.shutdownOpenTelemetry.mockImplementation(async () => {
      mocks.order.push("otel");
      throw failure;
    });

    await expect(shutdownObservability(5_000)).rejects.toBe(failure);
    expect(mocks.order).toEqual(["otel", "sentry"]);
  });

  test("returns false when Sentry exhausts its close timeout", async () => {
    mocks.closeSentry.mockImplementation(async () => {
      mocks.order.push("sentry");
      return false;
    });

    await expect(shutdownObservability(5_000)).resolves.toBe(false);
  });
});
