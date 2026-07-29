import { describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    constants: actual.constants,
    openSync: vi.fn(),
    closeSync: vi.fn(),
    writeSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const fs = await import("node:fs");
const { atomicWritePrivateFile } = await import("../utils/fs-atomic.js");

describe("atomicWritePrivateFile error handling", () => {
  test("throws and cleans up temp file when writeSync fails", () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.writeSync).mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => atomicWritePrivateFile("/tmp/target.txt", "hello")).toThrow("disk full");
    expect(fs.writeSync).toHaveBeenCalled();
  });

  test("throws and cleans up temp file when renameSync fails", () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.writeSync).mockReturnValue(undefined);
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error("cross device");
    });

    expect(() => atomicWritePrivateFile("/tmp/target.txt", "hello")).toThrow("cross device");
    expect(fs.renameSync).toHaveBeenCalled();
  });
});
