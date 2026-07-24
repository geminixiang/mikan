import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import {
  GondolinRuntimeRecordSchema,
  GondolinWorkerConfigSchema,
  GondolinWorkerHandshakeSchema,
  isGondolinRuntimeRecord,
} from "../src/sandbox/gondolin-contract.js";

interface ObjectSchema extends TSchema {
  properties: Record<string, TSchema>;
  required?: string[];
}

const CASES: Array<{ name: string; schema: ObjectSchema; value: Record<string, unknown> }> = [
  {
    name: "worker config",
    schema: GondolinWorkerConfigSchema as ObjectSchema,
    value: {
      instanceId: "slack:T123:C456:thread:1700000000.000000",
      imageSelector: "default",
      mounts: [{ source: "/srv/workspaces/demo", target: "/workspace" }],
      cpus: 2,
      memory: "4G",
      fingerprint: "sha256:0123456789abcdef",
      inventoryDir: "/var/lib/mikan/gondolin-runtimes",
      heartbeatStaleMs: 45000,
    },
  },
  {
    name: "worker handshake",
    schema: GondolinWorkerHandshakeSchema as ObjectSchema,
    value: {
      ready: true,
      sessionId: "runtime-abc123",
      socketPath: "/var/run/mikan/gondolin-runtime-abc123.sock",
      workerPid: 42001,
      runnerPid: 42002,
    },
  },
  {
    name: "runtime record",
    schema: GondolinRuntimeRecordSchema as ObjectSchema,
    value: {
      sessionId: "runtime-abc123",
      instanceId: "slack:T123:C456:thread:1700000000.000000",
      ownerPid: 42001,
      runnerPid: 42002,
      createdAt: "2026-01-01T00:00:00.000Z",
      socketPath: "/var/run/mikan/gondolin-runtime-abc123.sock",
      fingerprint: "sha256:0123456789abcdef",
    },
  },
];

describe("gondolin wire contract", () => {
  for (const entry of CASES) {
    test(`${entry.name} matches its schema with exact key coverage`, () => {
      expect(Value.Check(entry.schema, entry.value)).toBe(true);

      const declared = new Set(Object.keys(entry.schema.properties));
      for (const key of Object.keys(entry.value)) {
        expect(declared, `value key '${key}' is not declared in the schema`).toContain(key);
      }
      for (const key of entry.schema.required ?? []) {
        expect(
          Object.keys(entry.value),
          `required property '${key}' is missing from the value`,
        ).toContain(key);
      }
    });
  }

  test("the runtime-record guard accepts a valid record", () => {
    expect(isGondolinRuntimeRecord(CASES[2].value)).toBe(true);
  });
});
