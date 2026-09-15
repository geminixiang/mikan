import { afterEach, expect, test, vi } from "vitest";
import { join } from "node:path";
import { readSlackE2eEnv } from "../../e2e/slack/helpers/env.js";

afterEach(() => vi.unstubAllEnvs());

test("event fixtures follow the selected local daemon workspace", () => {
  vi.stubEnv("SLACK_QA_WORKING_DIR", "/tmp/isolated-slack-qa");
  vi.stubEnv("SLACK_QA_EVENTS_DIR", undefined);
  const env = readSlackE2eEnv();
  expect(env.eventsDir).toBe(join(env.workingDir, "events"));
});

test("an explicit events directory remains supported", () => {
  vi.stubEnv("SLACK_QA_WORKING_DIR", "/tmp/isolated-slack-qa");
  vi.stubEnv("SLACK_QA_EVENTS_DIR", "/tmp/separate-events");
  expect(readSlackE2eEnv().eventsDir).toBe("/tmp/separate-events");
});
