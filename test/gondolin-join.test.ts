import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GondolinJoinService, gondolinJoin } from "../src/sandbox/gondolin-join.js";

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

  test("enumerates durable enrolled worker identities strictly", async () => {
    expect(gondolinJoin.adoptLegacyWorkerCertificate("linux-1", "AA:11")).toBe(true);
    expect(gondolinJoin.adoptLegacyWorkerCertificate("linux-2", "BB:22")).toBe(true);
    expect(gondolinJoin.enrolledWorkerNames()).toEqual(["linux-1", "linux-2"]);

    writeFileSync(join(dir, "gateway", "workers", "linux-2.json"), "{}\n");
    expect(() => gondolinJoin.enrolledWorkerNames()).toThrow("Invalid Gondolin worker identity");
  });

  test("mints single-use tokens that expire", async () => {
    const minted = await gondolinJoin.mintToken();
    expect(minted.token).toMatch(/^[0-9a-f]{32}\.[A-Za-z0-9_-]+$/);
    expect(minted.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // secret is stored hashed, never in the clear
    const tokenId = minted.token.split(".")[0];
    const tokenPath = join(dir, "gateway", "tokens", `${tokenId}.json`);
    const stored = readFileSync(tokenPath, "utf8");
    expect(stored).not.toContain(minted.token.split(".")[1]);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

    expect(gondolinJoin.consumeToken("bogus", "linux-1")).toBe(false);
    expect(gondolinJoin.validateToken(minted.token, "linux-1")).toBe(true);
    expect(gondolinJoin.validateToken(minted.token, "linux-1")).toBe(true); // preflight is non-consuming
    expect(gondolinJoin.consumeToken(minted.token, "linux-1")).toBe(true);
    expect(existsSync(tokenPath)).toBe(false);
    expect(gondolinJoin.consumeToken(minted.token, "linux-1")).toBe(false); // burned

    const expiring = await gondolinJoin.mintToken();
    clock.now += 61_000;
    expect(gondolinJoin.consumeToken(expiring.token, "linux-2")).toBe(false);
  });

  test("token files make concurrent authorities lossless and single-consumer", async () => {
    const authorityA = new GondolinJoinService();
    const authorityB = new GondolinJoinService();
    const authorityDir = join(dir, "concurrent-gateway");
    authorityA.configure(authorityDir);
    authorityB.configure(authorityDir);

    const [first, second] = await Promise.all([authorityA.mintToken(), authorityB.mintToken()]);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(authorityA.validateToken(first.token, "worker-a")).toBe(true);
    expect(authorityB.validateToken(second.token, "worker-b")).toBe(true);

    const winners = [
      authorityA.consumeToken(first.token, "worker-a"),
      authorityB.consumeToken(first.token, "worker-a"),
    ];
    expect(winners.filter(Boolean)).toHaveLength(1);
    expect(authorityA.validateToken(second.token, "worker-b")).toBe(true);
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
    const csrPem = readFileSync(csrFile, "utf8");
    const signed = await gondolinJoin.signCsr(csrPem, "linux-1");

    await expect(gondolinJoin.signCsr(csrPem, "linux-2")).rejects.toThrow(
      "CSR common name must match worker name 'linux-2'",
    );
    await expect(gondolinJoin.signCsr(csrPem, "bad worker")).rejects.toThrow("worker name must be");

    const certificate = new X509Certificate(signed.certPem);
    expect(certificate.subject).toContain("CN=linux-1");
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    expect(certificate.checkIssued(new X509Certificate(signed.caPem))).toBe(true);
    expect(signed.caPem).toBe(caPem);
    expect(gondolinJoin.isIssuedWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      true,
    );
    expect(gondolinJoin.isActiveWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      false,
    );
    expect(gondolinJoin.activateWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      true,
    );
    expect(gondolinJoin.isActiveWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      true,
    );
    const genericRotation = await gondolinJoin.mintToken();
    expect(gondolinJoin.validateToken(genericRotation.token, "linux-1")).toBe(false);
    const scopedRotation = await gondolinJoin.mintToken("linux-1");
    expect(gondolinJoin.validateToken(scopedRotation.token, "linux-2")).toBe(false);
    expect(gondolinJoin.validateToken(scopedRotation.token, "linux-1")).toBe(true);

    const replacement = await gondolinJoin.signCsr(csrPem, "linux-1");
    const replacementCertificate = new X509Certificate(replacement.certPem);
    expect(replacementCertificate.fingerprint256).not.toBe(certificate.fingerprint256);
    // Issuance alone does not disconnect the active worker; its reconnect also
    // must not cancel the pending replacement.
    expect(gondolinJoin.activateWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      true,
    );
    expect(gondolinJoin.isActiveWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      true,
    );
    expect(
      gondolinJoin.isIssuedWorkerCertificate("linux-1", replacementCertificate.fingerprint256),
    ).toBe(true);
    expect(
      gondolinJoin.activateWorkerCertificate("linux-1", replacementCertificate.fingerprint256),
    ).toBe(true);
    expect(gondolinJoin.isActiveWorkerCertificate("linux-1", certificate.fingerprint256)).toBe(
      false,
    );
    expect(
      gondolinJoin.isActiveWorkerCertificate("linux-1", replacementCertificate.fingerprint256),
    ).toBe(true);
    const identityPath = join(dir, "gateway", "workers", "linux-1.json");
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);

    // The active binding is durable across gateway restarts.
    gondolinJoin.configure(join(dir, "gateway"));
    expect(
      gondolinJoin.isActiveWorkerCertificate("linux-1", replacementCertificate.fingerprint256),
    ).toBe(true);

    // Corruption fails closed instead of reverting to CA-only membership.
    writeFileSync(identityPath, "not-json");
    expect(
      gondolinJoin.isIssuedWorkerCertificate("linux-1", replacementCertificate.fingerprint256),
    ).toBe(false);
    expect(
      gondolinJoin.activateWorkerCertificate("linux-1", replacementCertificate.fingerprint256),
    ).toBe(false);
  });

  test("legacy certificate adoption is first-writer and durable", () => {
    expect(gondolinJoin.adoptLegacyWorkerCertificate("legacy", "AA:11")).toBe(true);
    expect(gondolinJoin.adoptLegacyWorkerCertificate("legacy", "BB:22")).toBe(false);
    expect(gondolinJoin.isActiveWorkerCertificate("legacy", "AA:11")).toBe(true);

    const secondAuthority = new GondolinJoinService();
    secondAuthority.configure(join(dir, "gateway"));
    expect(secondAuthority.adoptLegacyWorkerCertificate("legacy", "BB:22")).toBe(false);
    expect(secondAuthority.adoptLegacyWorkerCertificate("legacy", "AA:11")).toBe(true);
  });

  test("fails closed when an initialized CA becomes incomplete", async () => {
    await gondolinJoin.ensureCa();
    rmSync(gondolinJoin.paths().caKeyFile);

    await expect(gondolinJoin.ensureCa()).rejects.toThrow("CA is incomplete");
    expect(existsSync(gondolinJoin.paths().caKeyFile)).toBe(false);
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
