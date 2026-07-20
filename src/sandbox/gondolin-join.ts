import { execFile } from "node:child_process";
import { X509Certificate, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as log from "../log.js";
import { isRecord, readJsonFileIfExists } from "../utils/file-guards.js";
import { atomicWritePrivateFile } from "../utils/fs-atomic.js";

const execFileAsync = promisify(execFile);

const TOKEN_TTL_SECONDS = 15 * 60;
const CA_DAYS = 3650;
const SERVER_CERT_DAYS = 825;
const WORKER_CERT_DAYS = 365;
const WORKER_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const CA_LOCK_WAIT_MS = 30_000;

interface JoinTokenRecord {
  secretHash: string;
  expiresAt: number;
  workerName?: string;
}

interface WorkerIdentityRecord {
  name: string;
  activeFingerprint?: string;
  pendingFingerprint?: string;
  issuedAt: number;
}

function isWorkerIdentityRecord(value: unknown): value is WorkerIdentityRecord {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["name", "activeFingerprint", "pendingFingerprint", "issuedAt"].includes(key),
    ) &&
    typeof value.name === "string" &&
    WORKER_NAME_PATTERN.test(value.name) &&
    (value.activeFingerprint === undefined ||
      (typeof value.activeFingerprint === "string" && value.activeFingerprint.length > 0)) &&
    (value.pendingFingerprint === undefined ||
      (typeof value.pendingFingerprint === "string" && value.pendingFingerprint.length > 0)) &&
    (value.activeFingerprint !== undefined || value.pendingFingerprint !== undefined) &&
    typeof value.issuedAt === "number" &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt >= 0
  );
}

function isJoinTokenRecord(value: unknown): value is JoinTokenRecord {
  return (
    isRecord(value) &&
    typeof value.secretHash === "string" &&
    typeof value.expiresAt === "number" &&
    (value.workerName === undefined || typeof value.workerName === "string")
  );
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Certificate provisioning and join-token authority for dial-home workers.
 *
 * Owns a private CA under the state dir (`gondolin-gateway/`), auto-issues the
 * gateway's own server certificate from it, and exchanges one-time join
 * tokens for CA-signed worker client certificates — the kubeadm-style
 * bootstrap that replaces hand-provisioned mTLS material. All X.509 issuance
 * shells out to openssl (Node can parse but not issue certificates).
 */
export class GondolinJoinService {
  private dir?: string;
  private execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }> =
    execFileAsync;
  private now: () => number = Date.now;
  private tokenTtlSeconds = TOKEN_TTL_SECONDS;

  configure(
    dir?: string,
    overrides?: {
      execFile?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
      now?: () => number;
      tokenTtlSeconds?: number;
    },
  ): void {
    this.dir = dir;
    this.execImpl = overrides?.execFile ?? execFileAsync;
    this.now = overrides?.now ?? Date.now;
    this.tokenTtlSeconds = overrides?.tokenTtlSeconds ?? TOKEN_TTL_SECONDS;
  }

  isConfigured(): boolean {
    return this.dir !== undefined;
  }

  paths(): {
    caFile: string;
    caKeyFile: string;
    serverCertFile: string;
    serverKeyFile: string;
  } {
    const dir = this.requireDir();
    return {
      caFile: join(dir, "ca.pem"),
      caKeyFile: join(dir, "ca-key.pem"),
      serverCertFile: join(dir, "server.pem"),
      serverKeyFile: join(dir, "server-key.pem"),
    };
  }

  /** Create the worker CA on first use; idempotent afterwards. */
  async ensureCa(): Promise<void> {
    const { caFile, caKeyFile } = this.paths();
    const readyFile = join(this.requireDir(), ".ca-ready");
    if (existsSync(caFile) && existsSync(caKeyFile)) {
      if (!existsSync(readyFile)) atomicWritePrivateFile(readyFile, "ready\n");
      return;
    }
    if (existsSync(readyFile)) {
      throw new Error(
        "Gondolin worker CA is incomplete; restore ca.pem and ca-key.pem instead of rotating implicitly",
      );
    }
    mkdirSync(this.requireDir(), { recursive: true, mode: 0o700 });
    const release = await this.acquireCaLock();
    try {
      if (existsSync(caFile) && existsSync(caKeyFile)) {
        if (!existsSync(readyFile)) atomicWritePrivateFile(readyFile, "ready\n");
        return;
      }
      if (existsSync(readyFile)) {
        throw new Error("Gondolin worker CA became incomplete during initialization");
      }
      rmSync(caFile, { force: true });
      rmSync(caKeyFile, { force: true });
      await this.openssl([
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-keyout",
        caKeyFile,
        "-out",
        caFile,
        "-days",
        String(CA_DAYS),
        "-nodes",
        "-subj",
        "/CN=mikan-worker-ca",
      ]);
      atomicWritePrivateFile(readyFile, "ready\n");
      log.logInfo(`Gondolin worker CA created at ${caFile} (pin ${this.caFingerprint()})`);
    } finally {
      release();
    }
  }

  /**
   * Issue the gateway's server certificate from the worker CA so joining
   * workers can verify the host against the pinned CA. Reissued when the SAN
   * list changes.
   */
  async ensureServerCert(hostnames: string[]): Promise<{ certFile: string; keyFile: string }> {
    await this.ensureCa();
    const { caFile, caKeyFile, serverCertFile, serverKeyFile } = this.paths();
    const altNames = this.subjectAltNames(hostnames);
    if (existsSync(serverCertFile) && existsSync(serverKeyFile)) {
      const existing = new X509Certificate(readFileSync(serverCertFile));
      const current = (existing.subjectAltName ?? "")
        .split(", ")
        .filter(Boolean)
        .toSorted()
        .join(",");
      const wanted = altNames
        .split(",")
        .map((entry) => entry.replace("DNS:", "DNS:").replace("IP:", "IP Address:"))
        .toSorted()
        .join(",");
      if (current === wanted && this.now() < existing.validToDate.getTime() - 24 * 3600 * 1000) {
        return { certFile: serverCertFile, keyFile: serverKeyFile };
      }
    }
    const csrFile = join(this.requireDir(), "server.csr");
    const extFile = join(this.requireDir(), "server.ext");
    writeFileSync(extFile, `subjectAltName=${altNames}\n`);
    await this.openssl([
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-keyout",
      serverKeyFile,
      "-out",
      csrFile,
      "-nodes",
      "-subj",
      "/CN=mikan-gateway",
    ]);
    await this.openssl([
      "x509",
      "-req",
      "-in",
      csrFile,
      "-CA",
      caFile,
      "-CAkey",
      caKeyFile,
      "-CAcreateserial",
      "-days",
      String(SERVER_CERT_DAYS),
      "-extfile",
      extFile,
      "-out",
      serverCertFile,
    ]);
    rmSync(csrFile, { force: true });
    rmSync(extFile, { force: true });
    log.logInfo(`Gondolin gateway certificate issued for ${altNames}`);
    return { certFile: serverCertFile, keyFile: serverKeyFile };
  }

  /** SHA-256 of the CA certificate DER — the join command's --ca-pin. */
  caFingerprint(): string {
    const certificate = new X509Certificate(readFileSync(this.paths().caFile));
    return `sha256:${certificate.fingerprint256.replaceAll(":", "").toLowerCase()}`;
  }

  /** Mint a single-use join token; only its hash is stored. */
  async mintToken(
    workerName?: string,
  ): Promise<{ token: string; fingerprint: string; expiresAt: number }> {
    if (workerName !== undefined && !WORKER_NAME_PATTERN.test(workerName)) {
      throw new Error("worker name must be 1-128 letters, numbers, dots, underscores, or hyphens");
    }
    await this.ensureCa();
    const id = randomBytes(16).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.tokenTtlSeconds * 1000;
    const record: JoinTokenRecord = {
      secretHash: sha256Hex(secret),
      expiresAt,
      ...(workerName ? { workerName } : {}),
    };
    mkdirSync(this.tokensDir(), { recursive: true, mode: 0o700 });
    this.removeExpiredTokens();
    atomicWritePrivateFile(this.tokenPath(id), JSON.stringify(record, null, 2) + "\n");
    return { token: `${id}.${secret}`, fingerprint: this.caFingerprint(), expiresAt };
  }

  /** Check a join token without consuming it; used before expensive CSR validation. */
  validateToken(token: string, workerName: string): boolean {
    return this.checkToken(token, workerName, false);
  }

  /** Validate and burn a join token (single use, TTL-bounded). */
  consumeToken(token: string, workerName: string): boolean {
    return this.checkToken(token, workerName, true);
  }

  private checkToken(token: string, workerName: string, consume: boolean): boolean {
    const separator = token.indexOf(".");
    if (separator <= 0) return false;
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const record = this.readToken(id);
    if (!record || this.now() > record.expiresAt) return false;
    if (record.workerName !== undefined) {
      if (record.workerName !== workerName) return false;
    } else if (this.hasWorkerIdentity(workerName)) {
      return false;
    }
    const expected = Buffer.from(record.secretHash, "hex");
    const actual = createHash("sha256").update(secret).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    if (!consume) return true;
    const consumedPath = `${this.tokenPath(id)}.${process.pid}.${randomBytes(8).toString("hex")}.used`;
    try {
      renameSync(this.tokenPath(id), consumedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    rmSync(consumedPath, { force: true });
    return true;
  }

  /** Validate that a joining CSR is safe to bind to this placement identity. */
  async validateWorkerCsr(csrPem: string, workerName: string): Promise<void> {
    if (!WORKER_NAME_PATTERN.test(workerName)) {
      throw new Error("worker name must be 1-128 letters, numbers, dots, underscores, or hyphens");
    }
    const scratch = join(tmpdir(), `mikan-csr-${randomBytes(6).toString("hex")}`);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const csrFile = join(scratch, "worker.csr");
    try {
      writeFileSync(csrFile, csrPem);
      const { stdout: subject } = await this.openssl([
        "req",
        "-in",
        csrFile,
        "-noout",
        "-subject",
        "-nameopt",
        "RFC2253",
      ]);
      if (subject.trim() !== `subject=CN=${workerName}`) {
        throw new Error(`CSR common name must match worker name '${workerName}'`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** One-time migration for certificates issued before fingerprint bindings existed. */
  adoptLegacyWorkerCertificate(workerName: string, fingerprint: string): boolean {
    if (!WORKER_NAME_PATTERN.test(workerName)) return false;
    const existing = this.readWorkerIdentity(workerName);
    if (existing) {
      return (
        existing.activeFingerprint === fingerprint || existing.pendingFingerprint === fingerprint
      );
    }
    const identitiesDir = join(this.requireDir(), "workers");
    mkdirSync(identitiesDir, { recursive: true, mode: 0o700 });
    const record: WorkerIdentityRecord = {
      name: workerName,
      activeFingerprint: fingerprint,
      issuedAt: this.now(),
    };
    try {
      writeFileSync(this.workerIdentityPath(workerName), JSON.stringify(record, null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.readWorkerIdentity(workerName)?.activeFingerprint === fingerprint;
    }
  }

  /** Whether this certificate may register (active or just issued). */
  isIssuedWorkerCertificate(workerName: string, fingerprint: string): boolean {
    const record = this.readWorkerIdentity(workerName);
    return (
      record?.name === workerName &&
      (record.activeFingerprint === fingerprint || record.pendingFingerprint === fingerprint)
    );
  }

  /** Whether this certificate belongs to the currently registered identity. */
  isActiveWorkerCertificate(workerName: string, fingerprint: string): boolean {
    return this.readWorkerIdentity(workerName)?.activeFingerprint === fingerprint;
  }

  /** Promote a successfully registered certificate and revoke its predecessor. */
  activateWorkerCertificate(workerName: string, fingerprint: string): boolean {
    const record = this.readWorkerIdentity(workerName);
    if (
      record?.name !== workerName ||
      (record.activeFingerprint !== fingerprint && record.pendingFingerprint !== fingerprint)
    ) {
      return false;
    }
    if (record.activeFingerprint === fingerprint) return true;
    if (record.pendingFingerprint !== fingerprint) return false;
    this.writeWorkerIdentity({
      name: workerName,
      activeFingerprint: fingerprint,
      issuedAt: record.issuedAt,
    });
    return true;
  }

  /** Sign a joining worker's CSR with the worker CA after binding its CN. */
  async signCsr(csrPem: string, workerName: string): Promise<{ certPem: string; caPem: string }> {
    await this.validateWorkerCsr(csrPem, workerName);
    await this.ensureCa();
    const { caFile, caKeyFile } = this.paths();
    const scratch = join(tmpdir(), `mikan-join-${randomBytes(6).toString("hex")}`);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const csrFile = join(scratch, "worker.csr");
    const certFile = join(scratch, "worker.pem");
    const extFile = join(scratch, "worker.ext");
    try {
      writeFileSync(csrFile, csrPem);
      writeFileSync(extFile, "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=clientAuth\n");
      await this.openssl([
        "x509",
        "-req",
        "-in",
        csrFile,
        "-CA",
        caFile,
        "-CAkey",
        caKeyFile,
        "-set_serial",
        `0x${randomBytes(16).toString("hex")}`,
        "-days",
        String(WORKER_CERT_DAYS),
        "-extfile",
        extFile,
        "-out",
        certFile,
      ]);
      const certPem = readFileSync(certFile, "utf8");
      this.bindWorkerCertificate(workerName, certPem);
      return {
        certPem,
        caPem: readFileSync(caFile, "utf8"),
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private subjectAltNames(hostnames: string[]): string {
    const entries = new Set<string>(["IP:127.0.0.1", "DNS:localhost"]);
    for (const name of hostnames) {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(name) || name.includes(":")) entries.add(`IP:${name}`);
      else entries.add(`DNS:${name}`);
    }
    return Array.from(entries).join(",");
  }

  private async openssl(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.execImpl("openssl", args);
    } catch (err) {
      throw new Error(
        `openssl ${args[0]} failed (is openssl installed?): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private bindWorkerCertificate(workerName: string, certPem: string): void {
    const current = this.readWorkerIdentity(workerName);
    const certificate = new X509Certificate(certPem);
    this.writeWorkerIdentity({
      name: workerName,
      ...(current?.activeFingerprint ? { activeFingerprint: current.activeFingerprint } : {}),
      pendingFingerprint: certificate.fingerprint256,
      issuedAt: this.now(),
    });
  }

  private hasWorkerIdentity(workerName: string): boolean {
    return WORKER_NAME_PATTERN.test(workerName) && existsSync(this.workerIdentityPath(workerName));
  }

  private readWorkerIdentity(workerName: string): WorkerIdentityRecord | undefined {
    if (!WORKER_NAME_PATTERN.test(workerName)) return undefined;
    try {
      return readJsonFileIfExists(
        this.workerIdentityPath(workerName),
        isWorkerIdentityRecord,
        (detail) => `Malformed Gondolin worker identity: ${detail}`,
      );
    } catch (err) {
      log.logWarning(
        `Rejecting Gondolin worker '${workerName}' because its identity binding is unreadable`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  enrolledWorkerNames(): string[] {
    const identitiesDir = join(this.requireDir(), "workers");
    let entries;
    try {
      entries = readdirSync(identitiesDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Cannot enumerate Gondolin worker identities ${identitiesDir}`, {
        cause: error,
      });
    }
    const names = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const expectedName = entry.name.slice(0, -5);
      const path = join(identitiesDir, entry.name);
      const record = readJsonFileIfExists(
        path,
        isWorkerIdentityRecord,
        (detail) => `Invalid Gondolin worker identity ${path}: ${detail}`,
      );
      if (!record || record.name !== expectedName || names.has(record.name)) {
        throw new Error(`Invalid Gondolin worker identity authority at ${path}`);
      }
      names.add(record.name);
    }
    return Array.from(names).toSorted();
  }

  private writeWorkerIdentity(record: WorkerIdentityRecord): void {
    const identitiesDir = join(this.requireDir(), "workers");
    mkdirSync(identitiesDir, { recursive: true, mode: 0o700 });
    atomicWritePrivateFile(
      this.workerIdentityPath(record.name),
      JSON.stringify(record, null, 2) + "\n",
    );
  }

  private workerIdentityPath(workerName: string): string {
    return join(this.requireDir(), "workers", `${workerName}.json`);
  }

  private async acquireCaLock(): Promise<() => void> {
    const lockPath = join(this.requireDir(), ".ca-init.lock");
    const deadline = Date.now() + CA_LOCK_WAIT_MS;
    while (true) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        return () => rmSync(lockPath, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (Date.now() >= deadline) {
          throw new Error(
            `timed out waiting for Gondolin CA initialization; remove stale lock ${lockPath} only if no mikan process is initializing it`,
            { cause: err },
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  private tokensDir(): string {
    return join(this.requireDir(), "tokens");
  }

  private tokenPath(id: string): string {
    return join(this.tokensDir(), `${id}.json`);
  }

  private readToken(id: string): JoinTokenRecord | undefined {
    if (!/^[0-9a-f]{32}$/.test(id)) return undefined;
    try {
      return readJsonFileIfExists(
        this.tokenPath(id),
        isJoinTokenRecord,
        (detail) => `Malformed join token: ${detail}`,
      );
    } catch (err) {
      log.logWarning(
        "Rejecting malformed Gondolin join token",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private removeExpiredTokens(): void {
    for (const entry of readdirSync(this.tokensDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{32}\.json$/.test(entry.name)) continue;
      const id = entry.name.slice(0, -5);
      const record = this.readToken(id);
      if (!record || this.now() > record.expiresAt) rmSync(this.tokenPath(id), { force: true });
    }
  }

  private requireDir(): string {
    if (!this.dir) throw new Error("gondolin join service is not configured");
    return this.dir;
  }
}

export const gondolinJoin = new GondolinJoinService();
