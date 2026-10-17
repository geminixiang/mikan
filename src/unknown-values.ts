import type { JsonValue } from "@earendil-works/chord";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toJsonValue(input: unknown): JsonValue {
  if (input === undefined) return null;
  const copy: JsonValue = JSON.parse(JSON.stringify(input));
  return copy;
}
