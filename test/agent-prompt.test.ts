import { describe, expect, test } from "vitest";
import {
  appendTriggerAttribution,
  getUnresolvedSandboxPathContext,
  resolveTriggerAttribution,
  translateAttachPathToHost,
  translateRuntimePathToHost,
} from "../src/agent.js";

describe("trigger attribution", () => {
  test("uses event filename from event prompt marker", () => {
    expect(
      resolveTriggerAttribution({
        id: "123.456",
        text: "[EVENT:daily-summary.json:periodic:2026-05-19T00:00:00Z] summarize",
      }),
    ).toBe("[event: daily-summary.json]");
  });

  test("uses synthetic event id when prompt has no event marker", () => {
    expect(
      resolveTriggerAttribution({
        id: "event:daily-summary",
        text: "Handle the following recurring task.",
      }),
    ).toBe("[event: daily-summary]");
  });

  test("uses user name for normal user-triggered messages", () => {
    expect(resolveTriggerAttribution({ id: "123.456", text: "hello", userName: "david" })).toBe(
      "@david",
    );
  });

  test("omits attribution when no trigger identity is available", () => {
    expect(resolveTriggerAttribution({ id: "123.456", text: "hello" })).toBeUndefined();
  });
});

describe("append trigger attribution", () => {
  test("appends attribution to final chat response", () => {
    expect(appendTriggerAttribution("Done.", "@david")).toBe("Done.\n\n_Triggered by @david_");
  });

  test("does not duplicate existing attribution", () => {
    expect(appendTriggerAttribution("Done.\n\n_Triggered by @david_", "@david")).toBe(
      "Done.\n\n_Triggered by @david_",
    );
  });

  test("leaves text unchanged without attribution", () => {
    expect(appendTriggerAttribution("Done.", undefined)).toBe("Done.");
  });

  test("does not duplicate when attribution contains underscores", () => {
    const already = "Done.\n\n_Triggered by [event: foo_bar.json]_";
    expect(appendTriggerAttribution(already, "[event: foo_bar.json]")).toBe(already);
  });

  test("adds session link to event attribution", () => {
    expect(appendTriggerAttribution("Done.", "[event: daily]", "https://mikan/session?t=1")).toBe(
      "Done.\n\n_Triggered by [event: daily] · session: https://mikan/session?t=1_",
    );
  });

  test("upgrades existing event attribution with session link", () => {
    expect(
      appendTriggerAttribution(
        "Done.\n\n_Triggered by [event: daily]_",
        "[event: daily]",
        "https://mikan/session?t=1",
      ),
    ).toBe("Done.\n\n_Triggered by [event: daily] · session: https://mikan/session?t=1_");
  });
});

describe("runtime path context", () => {
  test("container runtime paths translate back to host paths", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "container", container: "mikan-sandbox" },
      "/host/workspace",
    );

    expect(pathContext).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(pathContext.runtimeToHostPath).toBeTypeOf("function");
    expect(translateRuntimePathToHost("/workspace/C123/report.txt", pathContext)).toBe(
      "/host/workspace/C123/report.txt",
    );
  });

  test("image sandbox has an initial runtime path before resolving to a container", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(pathContext).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(pathContext.runtimeToHostPath).toBeTypeOf("function");
    expect(translateRuntimePathToHost("/workspace/C123/report.txt", pathContext)).toBe(
      "/host/workspace/C123/report.txt",
    );
  });

  test("relative attach paths resolve from the runtime workspace", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(translateAttachPathToHost("gpt-5-mini.md", pathContext)).toBe(
      "/host/workspace/gpt-5-mini.md",
    );
  });

  test("absolute attach paths still translate from runtime to host", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(translateAttachPathToHost("/workspace/gpt-5-mini.md", pathContext)).toBe(
      "/host/workspace/gpt-5-mini.md",
    );
  });

  test("cloudflare keeps runtime paths remote and event control plane on host", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "cloudflare", sandboxId: "slack-u123" },
      "/host/workspace",
    );

    expect(pathContext).toMatchObject({
      hostWorkspaceRoot: "/host/workspace",
      runtimeWorkspaceRoot: "/workspace",
    });
    expect(pathContext.runtimeToHostPath).toBeUndefined();
    expect(translateRuntimePathToHost("/workspace/C123/report.txt", pathContext)).toBe(
      "/workspace/C123/report.txt",
    );
  });
});
