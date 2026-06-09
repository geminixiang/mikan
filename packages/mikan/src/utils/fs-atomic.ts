import {
  closeSync,
  constants as fsConstants,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, join } from "path";

const PRIVATE_FILE_MODE = 0o600;

/**
 * Write `content` to `targetPath` with mode 0600, even when `targetPath`
 * already exists. Uses O_CREAT|O_EXCL on a temp sibling (so the kernel
 * guarantees permissions at creation, not after a racy chmod) and then
 * rename(2) into place for atomicity. Readers never see a torn write,
 * and a crash mid-write leaves either the old file or a stray .tmp
 * (cleaned by the next attempt or manually) — never a half-written target.
 */
export function atomicWritePrivateFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const tmpPath = join(
    dir,
    `.${basename(targetPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const fd = openSync(
    tmpPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    PRIVATE_FILE_MODE,
  );
  try {
    writeSync(fd, content);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore — original error is more informative
    }
    throw err;
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
