import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { randomBytes } from "crypto";
import { platform } from "node:os";
import { basename, dirname, join } from "path";

const PRIVATE_FILE_MODE = 0o600;

/**
 * Write `content` to `targetPath` with mode 0600, even when `targetPath`
 * already exists. Uses O_CREAT|O_EXCL on a temp sibling (so the kernel
 * guarantees permissions at creation, not after a racy chmod) and then
 * rename(2) into place for atomicity. The staged file and parent directory
 * are fsynced, so a successful return is also a durable commit across host
 * crashes, not merely an atomic update visible to current readers. A crash
 * mid-write leaves either the old file or an orphaned private .tmp file —
 * never a half-written target.
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
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error(`Cannot make progress writing ${tmpPath}`);
      offset += written;
    }
    fsyncSync(fd);
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
    // Windows does not support opening directory handles through this API.
    // POSIX directory fsync makes the rename durable, which Gondolin's
    // distributed fencing contract requires on its supported host platforms.
    if (platform() !== "win32") {
      const dirFd = openSync(dir, fsConstants.O_RDONLY);
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    }
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}
