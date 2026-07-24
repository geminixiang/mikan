import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "vitest";
import {
  GondolinRuntimeRecordSchema,
  GondolinWorkerConfigSchema,
  GondolinWorkerHandshakeSchema,
  isGondolinRuntimeRecord,
} from "../src/sandbox/gondolin-contract.js";

const FIXTURES_DIR = join(__dirname, "..", "worker", "contract-fixtures");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8")) as Record<string, unknown>;
}

interface ObjectSchema extends TSchema {
  properties: Record<string, TSchema>;
  required?: string[];
}

/**
 * The shared fixtures pin both sides of the wire: the Go contract tests
 * round-trip the same files through the Go structs, and this suite checks
 * them against the TS schemas — including exact key coverage, so a field
 * added to a fixture without a schema property (or the reverse, for
 * required fields) fails here.
 */
const CASES: Array<{ fixture: string; schema: ObjectSchema }> = [
  { fixture: "worker-config.json", schema: GondolinWorkerConfigSchema as ObjectSchema },
  { fixture: "worker-handshake.json", schema: GondolinWorkerHandshakeSchema as ObjectSchema },
  { fixture: "runtime-record.json", schema: GondolinRuntimeRecordSchema as ObjectSchema },
];

describe("gondolin wire contract", () => {
  for (const entry of CASES) {
    test(`${entry.fixture} matches its schema with exact key coverage`, () => {
      const data = fixture(entry.fixture);
      expect(Value.Check(entry.schema, data)).toBe(true);

      const declared = new Set(Object.keys(entry.schema.properties));
      for (const key of Object.keys(data)) {
        expect(declared, `fixture key '${key}' is not declared in the schema`).toContain(key);
      }
      for (const key of entry.schema.required ?? []) {
        expect(
          Object.keys(data),
          `required property '${key}' is missing from the fixture`,
        ).toContain(key);
      }
    });
  }

  test("the runtime-record guard accepts the shared fixture", () => {
    expect(isGondolinRuntimeRecord(fixture("runtime-record.json"))).toBe(true);
  });
});
