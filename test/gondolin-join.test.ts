import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { gondolinJoin } from "../src/sandbox/gondolin-join.js";

describe("Gondolin join service", () => {
  let dir: string;
  let clock: { now: number };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-join-"));
    clock = { now: Date.now() };
    gondolinJoin.configure(join(dir, "gateway"), { now: () => clock.now, tokenTtlSeconds: 60 });
  });

  afterEach(() => {
    gondolinJoin.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  test("mints single-use tokens that expire", async () => {
    const minted = await gondolinJoin.mintToken();
    expect(minted.token).toMatch(/^[0-9a-f]{8}\.[A-Za-z0-9_-]+$/);
    expect(minted.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // secret is stored hashed, never in the clear
    const stored = readFileSync(join(dir, "gateway", "tokens.json"), "utf8");
    expect(stored).not.toContain(minted.token.split(".")[1]);

    expect(gondolinJoin.consumeToken("bogus")).toBe(false);
    expect(gondolinJoin.consumeToken(minted.token)).toBe(true);
    expect(gondolinJoin.consumeToken(minted.token)).toBe(false); // burned

    const expiring = await gondolinJoin.mintToken();
    clock.now += 61_000;
    expect(gondolinJoin.consumeToken(expiring.token)).toBe(false);
  });

  test("creates a CA once and signs worker CSRs with it", async () => {
    await gondolinJoin.ensureCa();
    const caPem = readFileSync(gondolinJoin.paths().caFile, "utf8");
    await gondolinJoin.ensureCa(); // idempotent
    expect(readFileSync(gondolinJoin.paths().caFile, "utf8")).toBe(caPem);

    // a worker-side CSR (openssl stands in for the Go client here)
    const csrKey = join(dir, "worker-key.pem");
    const csrFile = join(dir, "worker.csr");
    execFileSync("openssl", [
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-keyout",
      csrKey,
      "-out",
      csrFile,
      "-nodes",
      "-subj",
      "/CN=linux-1",
    ]);
    const signed = await gondolinJoin.signCsr(readFileSync(csrFile, "utf8"));

    const certificate = new X509Certificate(signed.certPem);
    expect(certificate.subject).toContain("CN=linux-1");
    expect(certificate.checkIssued(new X509Certificate(signed.caPem))).toBe(true);
    expect(signed.caPem).toBe(caPem);
  });

  test("issues a gateway server cert with the requested SANs", async () => {
    const issued = await gondolinJoin.ensureServerCert(["mikan.internal", "10.0.0.5"]);
    expect(existsSync(issued.certFile)).toBe(true);

    const certificate = new X509Certificate(readFileSync(issued.certFile));
    expect(certificate.subjectAltName).toContain("DNS:mikan.internal");
    expect(certificate.subjectAltName).toContain("IP Address:10.0.0.5");
    expect(certificate.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(
      certificate.checkIssued(new X509Certificate(readFileSync(gondolinJoin.paths().caFile))),
    ).toBe(true);

    // unchanged SANs → same cert; changed SANs → reissue
    const again = await gondolinJoin.ensureServerCert(["mikan.internal", "10.0.0.5"]);
    expect(readFileSync(again.certFile, "utf8")).toBe(readFileSync(issued.certFile, "utf8"));
    await gondolinJoin.ensureServerCert(["other.host"]);
    const reissued = new X509Certificate(readFileSync(issued.certFile));
    expect(reissued.subjectAltName).toContain("DNS:other.host");
  });
});
