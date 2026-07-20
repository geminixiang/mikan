import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    constants: actual.constants,
    openSync: vi.fn(),
    closeSync: vi.fn(),
    fsyncSync: vi.fn(),
    writeSync: vi.fn(),
    renameSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const fs = await import("node:fs");
const { atomicWritePrivateFile } = await import("../src/utils/fs-atomic.js");

describe("atomicWritePrivateFile error handling", () => {
  beforeEach(() => {
    vi.mocked(fs.openSync).mockReset().mockReturnValue(42);
    vi.mocked(fs.closeSync).mockReset();
    vi.mocked(fs.fsyncSync).mockReset();
    vi.mocked(fs.writeSync).mockReset().mockReturnValue(5);
    vi.mocked(fs.renameSync).mockReset();
    vi.mocked(fs.unlinkSync).mockReset();
  });

  test("throws and cleans up temp file when writeSync fails", () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.writeSync).mockImplementation(() => {
      throw new Error("disk full");
    });

    expect(() => atomicWritePrivateFile("/tmp/target.txt", "hello")).toThrow("disk full");
    expect(fs.writeSync).toHaveBeenCalled();
  });

  test("retries short writes before publishing", () => {
    vi.mocked(fs.openSync).mockReturnValueOnce(42).mockReturnValueOnce(43);
    vi.mocked(fs.writeSync).mockReturnValueOnce(2).mockReturnValueOnce(3);

    atomicWritePrivateFile("/tmp/target.txt", "hello");

    expect(fs.writeSync).toHaveBeenNthCalledWith(1, 42, expect.any(Buffer), 0, 5);
    expect(fs.writeSync).toHaveBeenNthCalledWith(2, 42, expect.any(Buffer), 2, 3);
    expect(fs.fsyncSync).toHaveBeenCalledWith(42);
    expect(fs.fsyncSync).toHaveBeenCalledWith(43);
  });

  test("fails closed when a write makes no progress", () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.writeSync).mockReturnValue(0);

    expect(() => atomicWritePrivateFile("/tmp/target.txt", "hello")).toThrow(
      "Cannot make progress",
    );
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  test("throws and cleans up temp file when renameSync fails", () => {
    vi.mocked(fs.openSync).mockReturnValue(42);
    vi.mocked(fs.writeSync).mockReturnValue(5);
    vi.mocked(fs.renameSync).mockImplementation(() => {
      throw new Error("cross device");
    });

    expect(() => atomicWritePrivateFile("/tmp/target.txt", "hello")).toThrow("cross device");
    expect(fs.renameSync).toHaveBeenCalled();
  });
});
