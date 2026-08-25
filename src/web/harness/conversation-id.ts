import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { HarnessPrincipal } from "@geminixiang/mikan-harness-web-contract";
import { createOfficeAddress, listRegisteredOffices, officeKey } from "../../office/index.js";
import type { OfficeAddress, OfficeKey } from "../../types.js";
import { ensureDirExists } from "../../utils/file-guards.js";

const KEY_FILENAME = "web-harness.key";
const KEY_BYTES = 32;
const OWNER_HEX_LENGTH = 24;
const CONVERSATION_ID_PATTERN = /^w1-([a-f0-9]{32})-([a-f0-9]{24})$/;
const HMAC_DOMAIN = "mikan-web-conversation-owner-v1";

/** Single authority for web conversation identity and principal ownership. */
export class WebConversationIdentity {
  private readonly key: Buffer;

  constructor(private readonly stateDir: string) {
    this.key = loadOrCreateKey(stateDir);
  }

  create(principal: HarnessPrincipal): OfficeAddress {
    const owner = this.ownerDigest(principal.id);
    const nonce = randomUUID().replaceAll("-", "");
    // Put the random nonce first so OfficeKey's readable diagnostic segment
    // never exposes the stable owner digest to browser DTOs.
    return createOfficeAddress("web", `w1-${nonce}-${owner}`);
  }

  owns(principal: HarnessPrincipal, address: OfficeAddress): boolean {
    if (address.platform !== "web") return false;
    const match = CONVERSATION_ID_PATTERN.exec(address.conversationId);
    if (!match?.[2]) return false;
    const expected = Buffer.from(this.ownerDigest(principal.id), "hex");
    const actual = Buffer.from(match[2], "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  listOwned(principal: HarnessPrincipal): OfficeAddress[] {
    return listRegisteredOffices(this.stateDir).flatMap((record) => {
      if (record.platform !== "web") return [];
      const address = createOfficeAddress(record.platform, record.conversationId);
      return this.owns(principal, address) ? [address] : [];
    });
  }

  resolveOwned(principal: HarnessPrincipal, key: OfficeKey): OfficeAddress | undefined {
    return this.listOwned(principal).find((address) => officeKey(address) === key);
  }

  private ownerDigest(principalId: string): string {
    return createHmac("sha256", this.key)
      .update(`${HMAC_DOMAIN}\0${principalId}`)
      .digest("hex")
      .slice(0, OWNER_HEX_LENGTH);
  }
}

function loadOrCreateKey(stateDir: string): Buffer {
  const path = join(stateDir, KEY_FILENAME);
  try {
    return readExistingKey(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  if (listRegisteredOffices(stateDir).some((record) => record.platform === "web")) {
    throw new Error(
      `Web Harness key is missing while web offices exist; restore ${path} before starting`,
    );
  }
  ensureDirExists(stateDir);
  const generated = randomBytes(KEY_BYTES);
  try {
    const fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    try {
      writeSync(fd, `${generated.toString("hex")}\n`);
    } finally {
      closeSync(fd);
    }
    return generated;
  } catch (error) {
    // Another daemon may have won first-start key creation. Re-read its key;
    // never continue with a process-local key that was not persisted.
    if (isErrno(error, "EEXIST")) return readExistingKey(path);
    throw error;
  }
}

function readExistingKey(path: string): Buffer {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Web Harness key must be a regular non-symlink file: ${path}`);
  }
  const raw = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error(`Web Harness key is malformed: ${path}`);
  return Buffer.from(raw, "hex");
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
