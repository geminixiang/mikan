import { afterEach, expect, test, vi } from "vitest";
import { readSlackE2eEnv } from "../../e2e/slack/helpers/env.js";

afterEach(() => vi.unstubAllEnvs());

test("intake log lookups follow the selected local daemon workspace", () => {
  vi.stubEnv("SLACK_QA_WORKING_DIR", "/tmp/isolated-slack-qa");
  expect(readSlackE2eEnv().workingDir).toBe("/tmp/isolated-slack-qa");
});
