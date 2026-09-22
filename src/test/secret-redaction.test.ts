import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { TODO_CONTEXT, type AgentHarnessToolInvocation } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { HostExecutor } from "../sandbox/host.js";
import { createSandboxExecutionEnv } from "../harness/execution-env.js";
import { adaptAgentTool, createSandboxTools, isHarnessTool } from "../harness/tools/pi-tools.js";
import {
  redactSecrets,
  withSecretRedaction,
  type SecretEntry,
} from "../harness/tools/secret-redaction.js";

const invocation: AgentHarnessToolInvocation = {
  invocationId: "inv-1",
  operationId: "op-1",
  turnId: "turn-1",
  getMemo: async () => undefined,
  setMemo: async () => {},
};

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("redactSecrets", () => {
  const secrets: SecretEntry[] = [
    { label: "OPENROUTER_API_KEY", value: "sk-or-v1-abcdefgh12345678" },
    { label: "SLACK_BOT_TOKEN", value: "xoxb-1114947441234" },
  ];

  test("replaces every occurrence of a known secret value with a labeled placeholder", () => {
    const text = `key is sk-or-v1-abcdefgh12345678 and again sk-or-v1-abcdefgh12345678`;
    expect(redactSecrets(text, secrets)).toBe(
      "key is [SECRET:OPENROUTER_API_KEY] and again [SECRET:OPENROUTER_API_KEY]",
    );
  });

  test("redacts multiple distinct secrets in the same text", () => {
    const text = "token=xoxb-1114947441234 key=sk-or-v1-abcdefgh12345678";
    expect(redactSecrets(text, secrets)).toBe(
      "token=[SECRET:SLACK_BOT_TOKEN] key=[SECRET:OPENROUTER_API_KEY]",
    );
  });

  test("leaves text with no secret occurrence untouched", () => {
    expect(redactSecrets("nothing sensitive here", secrets)).toBe("nothing sensitive here");
  });

  test("is a no-op for empty text or an empty secret list", () => {
    expect(redactSecrets("", secrets)).toBe("");
    expect(redactSecrets("sk-or-v1-abcdefgh12345678", [])).toBe("sk-or-v1-abcdefgh12345678");
  });

  test("prefers the longer match when one secret's value is a substring of another's", () => {
    const overlapping: SecretEntry[] = [
      { label: "SHORT", value: "abc12345" },
      { label: "LONG", value: "prefix-abc12345-suffix" },
    ];
    const text = "value is prefix-abc12345-suffix";
    const sorted = overlapping.toSorted((a, b) => b.value.length - a.value.length);
    expect(redactSecrets(text, sorted)).toBe("value is [SECRET:LONG]");
  });
});

describe("withSecretRedaction identity preservation", () => {
  test("keeps the isHarnessTool marker intact after wrapping", () => {
    const [bash] = createSandboxTools().filter((tool) => tool.name === "bash");
    expect(isHarnessTool(bash)).toBe(true);
    const wrapped = withSecretRedaction(bash!);
    expect(isHarnessTool(wrapped)).toBe(true);
  });

  test("a pack's own array reference sees the wrapped, redacting execute", async () => {
    const SENTINEL = "pack-secret-0123456789abcdef";
    const envBefore = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const agentTool = {
      name: "hold",
      label: "hold",
      description: "test tool",
      parameters: { type: "object", properties: {} } as never,
      execute: async () => ({
        content: [{ type: "text" as const, text: SENTINEL }],
        details: {},
      }),
    };
    const harnessTool = adaptAgentTool(agentTool);
    const packTools = [harnessTool];
    const modelTools = [harnessTool].map(withSecretRedaction);
    expect(isHarnessTool(packTools[0])).toBe(true);
    const result = await modelTools[0]!.execute(
      "call-1",
      {},
      () => {},
      undefined as never,
      invocation,
      TODO_CONTEXT,
    );
    const text = (result.content[0] as { text?: string }).text;
    expect(text).not.toContain(SENTINEL);
    expect(packTools[0]).toBe(modelTools[0]);
    if (envBefore === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = envBefore;
  });
});

describe("withSecretRedaction", () => {
  let dir: string;
  let envBefore: string | undefined;
  const SENTINEL_VALUE = "sk-test-sentinel-0123456789abcdef";

  beforeEach(() => {
    dir = join(tmpdir(), `mikan-secret-redaction-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    envBefore = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = SENTINEL_VALUE;
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    if (envBefore === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = envBefore;
  });

  test("redacts a configured secret that a real bash command echoes verbatim", async () => {
    const env = createSandboxExecutionEnv(new HostExecutor(), "host", dir);
    const [bash] = createSandboxTools()
      .filter((tool) => tool.name === "bash")
      .map(withSecretRedaction);
    const validated = validateToolArguments(bash!, {
      type: "toolCall",
      id: "call-1",
      name: "bash",
      arguments: { command: "echo $OPENROUTER_API_KEY", label: "print secret" },
    });

    const result = await bash!.execute(
      "call-1",
      validated,
      () => {},
      { env },
      invocation,
      TODO_CONTEXT,
    );

    const text = textOf(result as never);
    expect(text).not.toContain(SENTINEL_VALUE);
    expect(text).toContain("[SECRET:OPENROUTER_API_KEY]");
  });

  test("leaves output untouched when it contains no configured secret", async () => {
    const env = createSandboxExecutionEnv(new HostExecutor(), "host", dir);
    const [bash] = createSandboxTools()
      .filter((tool) => tool.name === "bash")
      .map(withSecretRedaction);
    const validated = validateToolArguments(bash!, {
      type: "toolCall",
      id: "call-2",
      name: "bash",
      arguments: { command: "echo hello-from-bash", label: "say hi" },
    });

    const result = await bash!.execute(
      "call-2",
      validated,
      () => {},
      { env },
      invocation,
      TODO_CONTEXT,
    );

    expect(textOf(result as never)).toContain("hello-from-bash");
  });

  test("propagates a tool error unchanged instead of swallowing it", async () => {
    const env = createSandboxExecutionEnv(new HostExecutor(), "host", dir);
    const [bash] = createSandboxTools()
      .filter((tool) => tool.name === "bash")
      .map(withSecretRedaction);
    const validated = validateToolArguments(bash!, {
      type: "toolCall",
      id: "call-3",
      name: "bash",
      arguments: { command: "exit 7", label: "fail" },
    });

    await expect(
      bash!.execute("call-3", validated, () => {}, { env }, invocation, TODO_CONTEXT),
    ).rejects.toThrow(/exit/i);
  });
});
