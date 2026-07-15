import { execFile } from "node:child_process";
import { X509Certificate, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as log from "../log.js";
import { isRecord, readJsonFileIfExists } from "../utils/file-guards.js";

const execFileAsync = promisify(execFile);

const TOKEN_TTL_SECONDS = 15 * 60;
const CA_DAYS = 3650;
const SERVER_CERT_DAYS = 825;
const WORKER_CERT_DAYS = 365;

interface JoinTokenRecord {
  id: string;
  secretHash: string;
  expiresAt: number;
  usedAt?: number;
}

function isTokenTable(value: unknown): value is { tokens: JoinTokenRecord[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.tokens) &&
    value.tokens.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.secretHash === "string" &&
        typeof entry.expiresAt === "number",
    )
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
class GondolinJoinService {
  private dir?: string;
  private execImpl: (cmd: string, args: string[]) => Promise<unknown> = execFileAsync;
  private now: () => number = Date.now;
  private tokenTtlSeconds = TOKEN_TTL_SECONDS;

  configure(
    dir?: string,
    overrides?: {
      execFile?: (cmd: string, args: string[]) => Promise<unknown>;
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
    if (existsSync(caFile) && existsSync(caKeyFile)) return;
    mkdirSync(this.requireDir(), { recursive: true, mode: 0o700 });
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
    log.logInfo(`Gondolin worker CA created at ${caFile} (pin ${this.caFingerprint()})`);
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
  async mintToken(): Promise<{ token: string; fingerprint: string; expiresAt: number }> {
    await this.ensureCa();
    const id = randomBytes(4).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + this.tokenTtlSeconds * 1000;
    const table = this.readTokens();
    table.push({ id, secretHash: sha256Hex(secret), expiresAt });
    this.writeTokens(table);
    return { token: `${id}.${secret}`, fingerprint: this.caFingerprint(), expiresAt };
  }

  /** Validate and burn a join token (single use, TTL-bounded). */
  consumeToken(token: string): boolean {
    const separator = token.indexOf(".");
    if (separator <= 0) return false;
    const id = token.slice(0, separator);
    const secret = token.slice(separator + 1);
    const table = this.readTokens();
    const record = table.find((entry) => entry.id === id);
    if (!record || record.usedAt !== undefined || this.now() > record.expiresAt) return false;
    const expected = Buffer.from(record.secretHash, "hex");
    const actual = createHash("sha256").update(secret).digest();
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    record.usedAt = this.now();
    this.writeTokens(table);
    return true;
  }

  /** Sign a joining worker's CSR with the worker CA. */
  async signCsr(csrPem: string): Promise<{ certPem: string; caPem: string }> {
    await this.ensureCa();
    const { caFile, caKeyFile } = this.paths();
    const scratch = join(tmpdir(), `mikan-join-${randomBytes(6).toString("hex")}`);
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const csrFile = join(scratch, "worker.csr");
    const certFile = join(scratch, "worker.pem");
    try {
      writeFileSync(csrFile, csrPem);
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
        String(WORKER_CERT_DAYS),
        "-out",
        certFile,
      ]);
      return {
        certPem: readFileSync(certFile, "utf8"),
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

  private async openssl(args: string[]): Promise<void> {
    try {
      await this.execImpl("openssl", args);
    } catch (err) {
      throw new Error(
        `openssl ${args[0]} failed (is openssl installed?): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private tokensPath(): string {
    return join(this.requireDir(), "tokens.json");
  }

  private readTokens(): JoinTokenRecord[] {
    let table: JoinTokenRecord[] = [];
    try {
      const parsed = readJsonFileIfExists(
        this.tokensPath(),
        isTokenTable,
        (detail) => `Malformed join token table: ${detail}`,
      );
      table = parsed?.tokens ?? [];
    } catch (err) {
      log.logWarning(
        "Resetting Gondolin join token table",
        err instanceof Error ? err.message : String(err),
      );
    }
    return table.filter((entry) => this.now() <= entry.expiresAt);
  }

  private writeTokens(tokens: JoinTokenRecord[]): void {
    mkdirSync(this.requireDir(), { recursive: true, mode: 0o700 });
    const staged = `${this.tokensPath()}.tmp`;
    writeFileSync(staged, JSON.stringify({ tokens }, null, 2) + "\n", { mode: 0o600 });
    renameSync(staged, this.tokensPath());
  }

  private requireDir(): string {
    if (!this.dir) throw new Error("gondolin join service is not configured");
    return this.dir;
  }
}

export const gondolinJoin = new GondolinJoinService();
