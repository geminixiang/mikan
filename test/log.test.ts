import { describe, expect, test } from "vitest";
import * as log from "../packages/mikan/src/log.js";

describe("log functions exist", () => {
  test("all expected log functions are exported", () => {
    expect(typeof log.logUserMessage).toBe("function");
    expect(typeof log.logToolStart).toBe("function");
    expect(typeof log.logToolSuccess).toBe("function");
    expect(typeof log.logToolError).toBe("function");
    expect(typeof log.logResponse).toBe("function");
    expect(typeof log.logThinking).toBe("function");
    expect(typeof log.logInfo).toBe("function");
    expect(typeof log.logWarning).toBe("function");
    expect(typeof log.logAgentError).toBe("function");
    expect(typeof log.logStartup).toBe("function");
    expect(typeof log.logConnected).toBe("function");
    expect(typeof log.logDisconnected).toBe("function");
  });
});
