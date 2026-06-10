import { afterEach, describe, expect, test, vi } from "vitest";
import { buildGondolinVmOptions } from "../src/sandbox/providers/gondolin.js";

describe("gondolin provider secret hooks", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  test("passes env directly when Tier 2 egress broker hosts are not configured", () => {
    delete process.env.MIKAN_GONDOLIN_SECRET_HOSTS;

    const options = buildGondolinVmOptions({ type: "gondolin" }, { GH_TOKEN: "ghp_secret" });

    expect(options.env).toEqual({ GH_TOKEN: "ghp_secret" });
    expect(options.httpHooks).toBeUndefined();
  });

  test("uses placeholder env and host-side http hooks when secret hosts are configured", () => {
    process.env.MIKAN_GONDOLIN_SECRET_HOSTS = "github.com, api.github.com";
    process.env.MIKAN_GONDOLIN_ALLOWED_HOSTS = "github.com, api.github.com";

    const options = buildGondolinVmOptions(
      { type: "gondolin", profile: "secure" },
      { GH_TOKEN: "ghp_secret" },
    );

    expect(options.sessionLabel).toBe("mikan:secure");
    expect(options.httpHooks).toBeDefined();
    expect(options.env).toHaveProperty("GH_TOKEN");
    expect((options.env as Record<string, string>).GH_TOKEN).not.toBe("ghp_secret");
    expect((options.env as Record<string, string>).GH_TOKEN).not.toHaveLength(0);
  });
});
