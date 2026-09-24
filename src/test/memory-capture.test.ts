import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai";
import {
  applyMemoryOps,
  CAPTURED_KNOWLEDGE_HEADING,
  isCapturableRun,
  MemoryCapture,
} from "../memory-capture/index.js";
import type { CapturedRun, MemoryCaptureOp } from "../memory-capture/index.js";
import { JevNotConfiguredError, MikanModels } from "../harness/index.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Office, Workspace } from "../office/index.js";

const NOW = new Date("2026-09-23T10:00:00.000Z");
const STAMP = "captured 2026-09-23 from 1.0001";

let root: string;
let workspace: Workspace;
let office: Office;
let originalStateDir: string | undefined;

beforeEach(() => {
  originalStateDir = process.env.MIKAN_STATE_DIR;
  root = mkdtempSync(join(tmpdir(), "mikan-memory-capture-"));
  workspace = createWorkspace({ root: join(root, "workspace"), stateDir: join(root, "state") });
  office = workspace.office(createOfficeAddress("slack", "C1"));
  mkdirSync(office.dir, { recursive: true });
});

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.MIKAN_STATE_DIR;
  else process.env.MIKAN_STATE_DIR = originalStateDir;
  rmSync(root, { recursive: true, force: true });
});

function run(overrides: Partial<CapturedRun> & { text?: string; id?: string } = {}): CapturedRun {
  const { text = "From now on, reply in Traditional Chinese.", id = "1.0001", ...rest } = overrides;
  return {
    office,
    message: {
      id,
      address: office.address,
      sessionKey: "C1",
      conversationKind: "shared",
      userId: "U1",
      text,
    },
    stopReason: "stop",
    reply: "Understood.",
    ...rest,
  };
}

function readMemory(): string {
  return readFileSync(office.memoryPath, "utf-8");
}

describe("isCapturableRun", () => {
  test("accepts a settled human run", () => {
    expect(isCapturableRun(run())).toBe(true);
  });

  test.each([
    ["an unfinished run", { stopReason: "aborted" }],
    ["an empty reply", { reply: "  " }],
    ["an event id", { id: "event:daily-check:1" }],
    ["an event payload", { text: "[EVENT:daily-check:periodic] check the queue" }],
  ])("skips %s", (_label, overrides) => {
    expect(isCapturableRun(run(overrides))).toBe(false);
  });
});

describe("applyMemoryOps", () => {
  test("creates the captured section at the end of an existing anchor", () => {
    const result = applyMemoryOps(
      "# Memory\n\n- Existing fact.\n",
      [{ op: "add", text: "Reply in Traditional Chinese." }],
      STAMP,
    );
    expect(result).toEqual({
      content: `# Memory\n\n- Existing fact.\n\n${CAPTURED_KNOWLEDGE_HEADING}\n\n- Reply in Traditional Chinese. (${STAMP})\n`,
      added: 1,
      updated: 0,
    });
  });

  test("keeps each entry on one line", () => {
    const { content } = applyMemoryOps(
      "",
      [{ op: "add", text: "Reply in\nTraditional  Chinese." }],
      STAMP,
    );
    expect(content).toBe(
      `${CAPTURED_KNOWLEDGE_HEADING}\n\n- Reply in Traditional Chinese. (${STAMP})\n`,
    );
  });

  test("appends inside the captured section before the next heading", () => {
    const memory = `${CAPTURED_KNOWLEDGE_HEADING}\n\n- First.\n\n## Open threads\n\n- Pending review.\n`;
    const { content } = applyMemoryOps(memory, [{ op: "add", text: "Second." }], STAMP);
    expect(content).toBe(
      `${CAPTURED_KNOWLEDGE_HEADING}\n\n- First.\n- Second. (${STAMP})\n\n## Open threads\n\n- Pending review.\n`,
    );
  });

  test("replaces the superseded line in place and skips knowledge already present", () => {
    const memory = "# Memory\n\n- Use the old dashboard for reports.\n- Reply in English.\n";
    const ops: MemoryCaptureOp[] = [
      {
        op: "update",
        replaces: "Use the old dashboard",
        text: "Use the new dashboard for reports.",
      },
      { op: "add", text: "Reply in English." },
    ];
    expect(applyMemoryOps(memory, ops, STAMP)).toEqual({
      content: `# Memory\n\n- Use the new dashboard for reports. (${STAMP})\n- Reply in English.\n`,
      added: 0,
      updated: 1,
    });
  });

  test("appends an update whose target line is gone and leaves unchanged memory identical", () => {
    const { content, added } = applyMemoryOps(
      "",
      [{ op: "update", replaces: "A line that was removed", text: "Replacement." }],
      STAMP,
    );
    expect(added).toBe(1);
    expect(content).toBe(`${CAPTURED_KNOWLEDGE_HEADING}\n\n- Replacement. (${STAMP})\n`);
    expect(
      applyMemoryOps("- Replacement.\n", [{ op: "add", text: "Replacement." }], STAMP),
    ).toEqual({
      content: "- Replacement.\n",
      added: 0,
      updated: 0,
    });
  });
});

describe("MemoryCapture", () => {
  const models = MikanModels.create({ modelsJsonPath: "/nonexistent/models.json" });

  test("does not extract or write when Jev scores the run below the threshold", async () => {
    const extract = vi.fn();
    const capture = new MemoryCapture(models, { gate: async () => 0.39, extract, now: () => NOW });
    capture.capture(run());
    await capture.idle();
    expect(extract).not.toHaveBeenCalled();
    expect(existsSync(office.memoryPath)).toBe(false);
  });

  test("skips runs that are not capturable without calling Jev", async () => {
    const gate = vi.fn(async () => 1);
    const capture = new MemoryCapture(models, { gate, extract: vi.fn(), now: () => NOW });
    capture.capture(run({ id: "event:daily:1" }));
    await capture.idle();
    expect(gate).not.toHaveBeenCalled();
  });

  test("writes extracted knowledge and gives the next capture the updated memory", async () => {
    writeFileSync(office.memoryPath, "# Memory\n");
    const seen: string[] = [];
    const capture = new MemoryCapture(models, {
      gate: async () => 0.9,
      extract: async (captured, memory) => {
        seen.push(memory);
        return [{ op: "add", text: `Rule from ${captured.message.id}.` }];
      },
      now: () => NOW,
    });

    capture.capture(run({ id: "1.0001" }));
    capture.capture(run({ id: "1.0002" }));
    await capture.idle();

    expect(seen[1]).toContain("Rule from 1.0001.");
    expect(readMemory()).toBe(
      `# Memory\n\n${CAPTURED_KNOWLEDGE_HEADING}\n\n- Rule from 1.0001. (captured 2026-09-23 from 1.0001)\n- Rule from 1.0002. (captured 2026-09-23 from 1.0002)\n`,
    );
  });

  test("applies ops to the file as it is when the write happens", async () => {
    writeFileSync(office.memoryPath, "# Memory\n");
    const capture = new MemoryCapture(models, {
      gate: async () => 0.9,
      extract: async () => {
        writeFileSync(office.memoryPath, "# Memory\n\n- Written by the agent meanwhile.\n");
        return [{ op: "add", text: "Captured rule." }];
      },
      now: () => NOW,
    });
    capture.capture(run());
    await capture.idle();
    expect(readMemory()).toContain("- Written by the agent meanwhile.");
    expect(readMemory()).toContain("- Captured rule.");
  });

  test("redacts configured secret values before writing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-value-123456");
    try {
      const capture = new MemoryCapture(models, {
        gate: async () => 0.9,
        extract: async () => [
          { op: "add", text: "Call the API with key sk-ant-test-value-123456." },
        ],
        now: () => NOW,
      });
      capture.capture(run());
      await capture.idle();
      expect(readMemory()).toContain("Call the API with key [SECRET:ANTHROPIC_API_KEY].");
      expect(readMemory()).not.toContain("sk-ant-test-value-123456");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("disables itself when Jev is not configured", async () => {
    const gate = vi.fn(async () => {
      throw new JevNotConfiguredError();
    });
    const capture = new MemoryCapture(models, { gate, extract: vi.fn(), now: () => NOW });
    capture.capture(run({ id: "1.0001" }));
    await capture.idle();
    capture.capture(run({ id: "1.0002" }));
    await capture.idle();
    expect(gate).toHaveBeenCalledOnce();
  });

  test("keeps later captures working after an extraction failure", async () => {
    const extract = vi
      .fn<(captured: CapturedRun, memory: string) => Promise<MemoryCaptureOp[]>>()
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce([{ op: "add", text: "Recovered rule." }]);
    const capture = new MemoryCapture(models, { gate: async () => 0.9, extract, now: () => NOW });
    capture.capture(run({ id: "1.0001" }));
    capture.capture(run({ id: "1.0002" }));
    await capture.idle();
    expect(readMemory()).toContain("- Recovered rule. (captured 2026-09-23 from 1.0002)");
  });

  function officeModels(): { models: MikanModels; faux: ReturnType<typeof fauxProvider> } {
    process.env.MIKAN_STATE_DIR = workspace.stateDir;
    mkdirSync(workspace.stateDir, { recursive: true });
    writeFileSync(
      join(workspace.stateDir, "settings.json"),
      JSON.stringify({ llm: { provider: "faux", model: "faux-1", thinkingLevel: "off" } }),
    );
    const created = MikanModels.create({ modelsJsonPath: join(workspace.stateDir, "models.json") });
    const faux = fauxProvider();
    (created.models as MutableModels).setProvider(faux.provider);
    return { models: created, faux };
  }

  test("extracts with the office model from the exchange and current memory", async () => {
    const { models: withFaux, faux } = officeModels();
    writeFileSync(office.memoryPath, "# Memory\n\n- Existing anchor line.\n");
    faux.setResponses([
      (context) => {
        const prompt = JSON.stringify(context);
        expect(prompt).toContain("Existing anchor line.");
        expect(prompt).toContain("From now on, reply in Traditional Chinese.");
        expect(prompt).toContain("Never record secrets");
        return fauxAssistantMessage(
          '{"ops":[{"op":"add","text":"Reply in Traditional Chinese."}]}',
        );
      },
    ]);

    const capture = new MemoryCapture(withFaux, { gate: async () => 0.9, now: () => NOW });
    capture.capture(run());
    await capture.idle();

    expect(readMemory()).toContain(`- Reply in Traditional Chinese. (${STAMP})`);
  });

  test("writes nothing when the extraction does not match the output schema", async () => {
    const { models: withFaux, faux } = officeModels();
    writeFileSync(office.memoryPath, "# Memory\n");
    faux.setResponses([fauxAssistantMessage('{"ops":[{"op":"delete","text":"Old rule."}]}')]);

    const capture = new MemoryCapture(withFaux, { gate: async () => 0.9, now: () => NOW });
    capture.capture(run());
    await capture.idle();

    expect(readMemory()).toBe("# Memory\n");
  });
});
