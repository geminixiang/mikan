import { describe, expect, test } from "vitest";
import {
  appendTriggerAttribution,
  buildTurnInstructions,
  resolveTriggerAttribution,
  translateAttachPathToHost,
  translateRuntimePathToHost,
} from "../agent.js";
import { getUnresolvedSandboxPathContext } from "../sandbox/index.js";

describe("trigger attribution", () => {
  test("uses explicit scheduled-event origin", () => {
    expect(
      resolveTriggerAttribution({
        origin: { kind: "scheduled-event", eventId: "daily-summary" },
      }),
    ).toBe("[event: daily-summary]");
  });

  test("does not treat an interactive event-like message id or prompt as scheduled", () => {
    expect(
      resolveTriggerAttribution({
        origin: { kind: "interactive" },
        userName: "david",
      }),
    ).toBe("@david");
  });

  test("uses user name for normal user-triggered messages", () => {
    expect(resolveTriggerAttribution({ origin: { kind: "interactive" }, userName: "david" })).toBe(
      "@david",
    );
  });

  test("omits attribution when no trigger identity is available", () => {
    expect(resolveTriggerAttribution({ origin: { kind: "interactive" } })).toBeUndefined();
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

  test("adds session link outside the italic span (Slack italics can't span URLs)", () => {
    expect(appendTriggerAttribution("Done.", "[event: daily]", "https://mikan/session?t=1")).toBe(
      "Done.\n\n_Triggered by [event: daily]_ · session: https://mikan/session?t=1",
    );
  });

  test("upgrades existing event attribution with session link", () => {
    expect(
      appendTriggerAttribution(
        "Done.\n\n_Triggered by [event: daily]_",
        "[event: daily]",
        "https://mikan/session?t=1",
      ),
    ).toBe("Done.\n\n_Triggered by [event: daily]_ · session: https://mikan/session?t=1");
  });
});

describe("turn instructions", () => {
  test("empty for a plain interactive turn", () => {
    expect(buildTurnInstructions(false, undefined, "slack")).toBe("");
  });

  test("includes attribution with the platform name and trigger", () => {
    const result = buildTurnInstructions(false, "@david", "slack");
    expect(result).toContain("## Attribution");
    expect(result).toContain("final slack response");
    expect(result).toContain("_Triggered by @david_");
    expect(result).not.toContain("## Event Trigger Mode");
  });

  test("includes event-trigger mode for event runs", () => {
    const result = buildTurnInstructions(true, "[event: daily]", "telegram");
    expect(result).toContain("## Event Trigger Mode");
    expect(result).toContain("## Attribution");
    expect(result).toContain("_Triggered by [event: daily]_");
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

  test("keeps an absolute host attach path inside the host workspace", () => {
    const pathContext = getUnresolvedSandboxPathContext({ type: "host" }, "/host/workspace");

    expect(translateAttachPathToHost("/host/workspace/report.txt", pathContext)).toBe(
      "/host/workspace/report.txt",
    );
  });

  test("rejects parent traversal in attach paths", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(() => translateAttachPathToHost("../outside.txt", pathContext)).toThrow(
      "parent-directory traversal",
    );
    expect(() => translateAttachPathToHost("/workspace/C123/../outside.txt", pathContext)).toThrow(
      "parent-directory traversal",
    );
  });

  test("rejects absolute host paths outside the runtime workspace", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "image", image: "ubuntu:24.04" },
      "/host/workspace",
    );

    expect(() => translateAttachPathToHost("/etc/passwd", pathContext)).toThrow(
      "runtime workspace",
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
    expect(() => translateAttachPathToHost("report.txt", pathContext)).toThrow(
      "attachments are unavailable",
    );
  });

  test("firecracker rejects host uploads explicitly", () => {
    const pathContext = getUnresolvedSandboxPathContext(
      { type: "firecracker", vmId: "vm-1", hostPath: "/host/workspace" },
      "/host/workspace",
    );

    expect(() => translateAttachPathToHost("report.txt", pathContext)).toThrow(
      "attachments are unavailable",
    );
  });
});
