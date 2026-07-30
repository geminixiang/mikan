import { describe, expect, test } from "vitest";
import { formatLocalTimestamp } from "../sessions/history-line.js";

describe("formatLocalTimestamp", () => {
  test("formats a valid date", () => {
    // Use a fixed date: 2024-01-15 10:30:45 in local time
    const date = new Date("2024-01-15T10:30:45");
    const result = formatLocalTimestamp(date);
    expect(result).toMatch(/^2024-01-15 \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  test("returns null for invalid date (NaN)", () => {
    const date = new Date("invalid");
    const result = formatLocalTimestamp(date);
    expect(result).toBeNull();
  });

  test("returns null for Infinity", () => {
    const date = new Date(Infinity);
    const result = formatLocalTimestamp(date);
    expect(result).toBeNull();
  });

  test("returns null for -Infinity", () => {
    const date = new Date(-Infinity);
    const result = formatLocalTimestamp(date);
    expect(result).toBeNull();
  });

  test("formats epoch correctly", () => {
    const date = new Date(0);
    const result = formatLocalTimestamp(date);
    expect(result).toMatch(/^1970-01-01 \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  test("formats date at month and day boundaries", () => {
    const date = new Date("2024-02-29T23:59:59"); // leap year
    const result = formatLocalTimestamp(date);
    expect(result).toMatch(/^2024-02-29 \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
});
