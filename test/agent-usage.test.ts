import { describe, expect, test } from "vitest";
import { shouldReportUsageSummary } from "../src/agent.js";

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: 0 },
};

describe("shouldReportUsageSummary", () => {
  test("reports token usage even when pricing is unavailable", () => {
    expect(shouldReportUsageSummary({ ...emptyUsage, input: 123 })).toBe(true);
  });

  test("skips empty usage", () => {
    expect(shouldReportUsageSummary(emptyUsage)).toBe(false);
  });
});
