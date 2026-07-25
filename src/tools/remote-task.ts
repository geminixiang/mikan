import type { AgentTool } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { readEnv } from "../utils/env.js";
import { truncateTail, formatSize, DEFAULT_MAX_BYTES } from "./truncate.js";

/**
 * Task executor: run one command in a throwaway remote sandbox.
 *
 * This is deliberately *not* a sandbox runtime (see ADR 0002). It holds no
 * workspace projection, so nothing it writes survives the call and nothing
 * from the conversation's workspace is visible to it. Each call gets a fresh
 * sandbox id, so concurrent calls cannot see or disturb each other — which is
 * the point: fan-out work, not the agent's computer.
 *
 * Credentials are not injected. The conversation vault belongs to the sandbox
 * runtime; a throwaway remote task gets only what the command carries.
 */

const DEFAULT_CWD = "/workspace";
const DEFAULT_TIMEOUT_SECONDS = 120;

const parameters = Type.Object({
  command: Type.String({
    description: "Shell command to run in a fresh remote sandbox.",
  }),
  timeout: Type.Optional(
    Type.Number({
      description: `Seconds before the command is aborted (default ${DEFAULT_TIMEOUT_SECONDS}).`,
    }),
  ),
});

type RemoteTaskParams = Static<typeof parameters>;

interface RemoteTaskPayload {
  sandboxId: string;
  command: string;
  timeoutSeconds?: number;
  cwd?: string;
}

interface RemoteTaskResponse {
  stdout?: string;
  stderr?: string;
  code?: number;
  error?: string;
}

/** The bridge URL, or undefined when no remote executor is configured. */
export function remoteTaskBridgeUrl(): URL | undefined {
  const raw = readEnv("CLOUDFLARE_SANDBOX_URL");
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function bridgeHeaders(): Record<string, string> {
  const token = readEnv("CLOUDFLARE_SANDBOX_TOKEN");
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

/** A fresh sandbox per call — no state is carried between invocations. */
function throwawaySandboxId(): string {
  return `mikan-task-${randomUUID()}`;
}

export function createRemoteTaskTool(): AgentTool<typeof parameters> {
  return {
    name: "remote_task",
    label: "remote_task",
    description:
      "Run a command in a fresh, isolated remote sandbox and return its output. " +
      "Each call gets its own throwaway sandbox, so several calls can run in parallel " +
      "without interfering. Nothing persists: the sandbox has no access to the workspace, " +
      "no credentials, and is discarded when the command finishes. " +
      "Use it for parallelisable work that only needs its input in the command and its " +
      "result on stdout — not for anything that must read or write project files.",
    parameters,
    execute: async (_toolCallId: string, args: RemoteTaskParams, signal?: AbortSignal) => {
      const url = remoteTaskBridgeUrl();
      if (!url) {
        throw new Error(
          "remote_task is unavailable: CLOUDFLARE_SANDBOX_URL is not set on the mikan host.",
        );
      }

      const timeoutSeconds =
        args.timeout && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_SECONDS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      const onAbort = (): void => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", onAbort, { once: true });

      const payload: RemoteTaskPayload = {
        sandboxId: throwawaySandboxId(),
        command: args.command,
        timeoutSeconds,
        cwd: readEnv("CLOUDFLARE_SANDBOX_CWD") || DEFAULT_CWD,
      };

      let parsed: RemoteTaskResponse;
      try {
        const response = await fetch(new URL("/exec", url), {
          method: "POST",
          headers: bridgeHeaders(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const raw = (await response.text()).trim();
        parsed = raw ? (JSON.parse(raw) as RemoteTaskResponse) : {};
        if (!response.ok) {
          throw new Error(
            parsed.error || parsed.stderr || `remote sandbox returned HTTP ${response.status}`,
          );
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(
            signal?.aborted
              ? "remote_task aborted"
              : `remote_task timed out after ${timeoutSeconds} seconds`,
            { cause: error },
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      let output = "";
      if (parsed.stdout) output += parsed.stdout;
      if (parsed.stderr) {
        if (output) output += "\n";
        output += parsed.stderr;
      }

      const truncation = truncateTail(output);
      let text = truncation.content || "(no output)";
      if (truncation.truncated) {
        // No workspace to spill into — a task executor has nowhere to put it.
        text += `\n\n[Showing the last ${formatSize(truncation.outputBytes)} of ${formatSize(
          Buffer.byteLength(output, "utf-8"),
        )} (${formatSize(DEFAULT_MAX_BYTES)} limit). Have the command summarise or filter its own output.]`;
      }

      const code = parsed.code ?? 0;
      if (code !== 0) {
        throw new Error(`${text}\n\nCommand exited with code ${code}`.trim());
      }
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };
}
