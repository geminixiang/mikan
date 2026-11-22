import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as log from "../log.js";
import { SandboxError } from "../sandbox/utils.js";
import { parseSandboxArg } from "../sandbox/registry.js";

describe("parseSandboxArg", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("parses the oci sandbox for mikan-managed per-office containers", () => {
    const warn = vi.spyOn(log, "logWarning");
    expect(parseSandboxArg("oci:ubuntu:24.04")).toEqual({ image: "ubuntu:24.04" });
    expect(warn).not.toHaveBeenCalled();
  });

  test("oci alone runs the sandbox image published for this mikan version", () => {
    const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(parseSandboxArg("oci")).toEqual({
      image: `ghcr.io/geminixiang/mikan-sandbox:${version}`,
    });
  });

  test("accepts the former image: spelling with a deprecation warning", () => {
    const warn = vi.spyOn(log, "logWarning").mockImplementation(() => {});
    expect(parseSandboxArg("image:ubuntu:24.04")).toEqual({ image: "ubuntu:24.04" });
    expect(warn).toHaveBeenCalledWith(
      "--sandbox=image:ubuntu:24.04 is deprecated",
      "use --sandbox=oci:ubuntu:24.04; image: will be removed in the next major release",
    );
  });

  test("an oci sandbox needs an image", () => {
    expect(() => parseSandboxArg("oci:")).toThrowError(SandboxError);
  });

  test("removed backends are rejected as invalid sandbox types", () => {
    expect(() => parseSandboxArg("gondolin:default")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("firecracker:vm1:/srv/workspace")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("cloudflare:slack-u123")).toThrowError(SandboxError);
  });

  test("rejects unsupported sandbox type", () => {
    expect(() => parseSandboxArg("podman:mikan")).toThrowError(SandboxError);
    expect(() => parseSandboxArg("podman:mikan")).toThrow("Error: Invalid sandbox 'podman:mikan'");
  });

  test.each(["host", "container:mikan-sandbox", "docker:mikan-sandbox"])(
    "refuses the removed %s mode and names oci",
    (spec) => {
      expect(() => parseSandboxArg(spec)).toThrowError(SandboxError);
      expect(() => parseSandboxArg(spec)).toThrow(/is not supported.*'oci'/);
    },
  );
});
