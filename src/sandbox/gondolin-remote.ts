import { readFileSync, statSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { relative, isAbsolute, join } from "node:path";
import * as log from "../log.js";
import type { GondolinRemoteWorkerSettings } from "../types.js";
import { SandboxError } from "./errors.js";
import {
  createSessionFrameParser,
  encodeSessionMessage,
  type GondolinCredentialFile,
  type GondolinEnsureRuntimeRequest,
  type GondolinRemoteRuntime,
} from "./gondolin-contract.js";
import { GondolinRuntimeGoneError, isLeaseFencedStatus } from "./gondolin-recovery.js";
import {
  execOverSessionConnect,
  type GondolinRuntimeHandle,
  type GondolinRuntimeSpec,
  type SessionClient,
  type SessionClientCallbacks,
} from "./gondolin-worker-client.js";
import type { ExecResult } from "./types.js";

/** Wire compatibility shared by static and dial-home remote worker transports. */
export const GONDOLIN_REMOTE_PROTOCOL_VERSION = 2;
export const GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION = 1;

function isCompatibleProtocolVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION &&
    value <= GONDOLIN_REMOTE_PROTOCOL_VERSION
  );
}

const LEASE_TTL_SECONDS = 300;
/** Covers the daemon's 15s lease janitor plus runtime watchdog scheduling jitter. */
export const GONDOLIN_FENCING_GRACE_SECONDS = 45;
const REQUEST_TIMEOUT_MS = 15_000;
const LEASE_ACQUIRE_TIMEOUT_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_CLOCK_UNCERTAINTY_MS = 2_500;
const MAX_RESPONSE_BYTES = 1 << 20;
/** VM boot happens inside this request; the daemon's own handshake cap is 2 min. */
const ENSURE_TIMEOUT_MS = 150_000;

interface RemoteLease {
  leaseId: string;
  epoch: number;
  renewTimer: NodeJS.Timeout;
}

interface RemoteResponse {
  status: number;
  json: Record<string, unknown>;
}

/** A request that never reached the daemon (network/TLS/timeout failure). */
export class GondolinWorkerUnreachableError extends Error {}

export class GondolinClockSkewError extends SandboxError {
  constructor(
    readonly clockSkewMs: number,
    readonly clockUncertaintyMs: number,
    message = `Error: gondolin remote worker clock differs by approximately ${clockSkewMs}ms; synchronize host clocks`,
  ) {
    super(message);
  }
}

export interface GondolinRemoteOverrides {
  request?: (
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
  ) => Promise<RemoteResponse>;
  tunnel?: (
    path: string,
    headers: Record<string, string>,
    callbacks: SessionClientCallbacks,
  ) => SessionClient | Promise<SessionClient>;
  httpsRequest?: typeof httpsRequest;
  leaseTtlSeconds?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  /** Reports lease grants/renewals so the fleet can persist fencing watermarks. */
  onLeaseActivity?: (instanceId: string, expiresAtMs: number) => void;
}

// The framing lives with the rest of the wire contract; re-exported here for
// existing importers.
export { createSessionFrameParser, encodeSessionMessage };

/**
 * One mikan-worker daemon as seen from mikan: mTLS requests, per-instance
 * fenced leases with heartbeat renewal, and per-command upgraded tunnels.
 * Commands travel through one tunnel each, so abort semantics match the local
 * transport exactly.
 */
export class GondolinRemoteConnection {
  private readonly leases = new Map<string, RemoteLease>();
  private readonly leaseTtlSeconds: number;
  private readonly requestTimeoutMs: number;
  private protocolVerified = false;
  private protocolVersion?: number;
  private tls?: { ca?: Buffer; cert: Buffer; key: Buffer };

  constructor(
    private readonly settings: GondolinRemoteWorkerSettings,
    private readonly overrides: GondolinRemoteOverrides = {},
  ) {
    this.leaseTtlSeconds = overrides.leaseTtlSeconds ?? LEASE_TTL_SECONDS;
    this.requestTimeoutMs = overrides.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private validateClockSample(
    serverTime: unknown,
    startedAt: number,
    startedMonotonic: number,
    monotonicNow: () => number,
    required: boolean,
  ): { clockSkewMs: number; clockUncertaintyMs: number } | undefined {
    if (typeof serverTime !== "string" || !Number.isFinite(Date.parse(serverTime))) {
      if (required) {
        throw new SandboxError("Error: gondolin remote worker returned an invalid server time");
      }
      return undefined;
    }
    const elapsedMs = monotonicNow() - startedMonotonic;
    const midpoint = startedAt + elapsedMs / 2;
    const clockSkewMs = Date.parse(serverTime) - midpoint;
    const clockUncertaintyMs = elapsedMs / 2;
    if (clockUncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS) {
      throw new GondolinClockSkewError(
        Math.round(clockSkewMs),
        Math.round(clockUncertaintyMs),
        `Error: gondolin remote worker health round trip is too slow to verify clock safety (${Math.round(elapsedMs)}ms)`,
      );
    }
    if (Math.max(0, Math.abs(clockSkewMs) - clockUncertaintyMs) > MAX_CLOCK_SKEW_MS) {
      throw new GondolinClockSkewError(Math.round(clockSkewMs), Math.round(clockUncertaintyMs));
    }
    return {
      clockSkewMs: Math.round(clockSkewMs),
      clockUncertaintyMs: Math.round(clockUncertaintyMs),
    };
  }

  /** Drop lease timers and caches (does not touch the daemon). */
  dispose(): void {
    for (const lease of this.leases.values()) clearInterval(lease.renewTimer);
    this.leases.clear();
  }

  async health(): Promise<Record<string, unknown>> {
    const now = this.overrides.now ?? Date.now;
    const monotonicNow = this.overrides.monotonicNow ?? performance.now.bind(performance);
    const startedAt = now();
    const startedMonotonic = monotonicNow();
    const response = await this.request("GET", "/v1/health");
    if (response.status !== 200) {
      throw new SandboxError(
        `Error: gondolin remote worker health check failed (${response.status})`,
      );
    }
    if (!isCompatibleProtocolVersion(response.json.protocolVersion)) {
      throw new SandboxError(
        `Error: incompatible gondolin remote worker protocol ` +
          `(supported ${GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION}-${GONDOLIN_REMOTE_PROTOCOL_VERSION}, got ${String(response.json.protocolVersion ?? "missing")})`,
      );
    }
    const sample = this.validateClockSample(
      response.json.serverTime,
      startedAt,
      startedMonotonic,
      monotonicNow,
      response.json.protocolVersion >= 2,
    );
    if (sample) Object.assign(response.json, sample);
    this.protocolVerified = true;
    this.protocolVersion = response.json.protocolVersion;
    return response.json;
  }

  async ensure(instanceId: string, spec: GondolinRuntimeSpec): Promise<GondolinRuntimeHandle> {
    if (!this.protocolVerified) await this.health();
    if (spec.network && (this.protocolVersion ?? 0) < 2) {
      throw new SandboxError(
        "Error: Gondolin network policy requires remote worker protocol 2 or newer",
      );
    }
    const { mounts, credentialFiles } = this.translateMounts(spec);
    const body: GondolinEnsureRuntimeRequest = {
      instanceId,
      imageSelector: spec.image,
      mounts,
      credentialFiles,
      cpus: spec.cpus ?? "",
      memory: spec.memory ?? "",
      fingerprint: spec.fingerprint,
      network: spec.network,
      // A detached runtime must stop if its supervising daemon disappears.
      // Keep the threshold above the daemon's 15s heartbeat period while
      // still fencing it before host failover becomes eligible.
      heartbeatStaleMs: Math.max((this.leaseTtlSeconds * 1000) / 2, 30_000),
    };
    const idempotencyKey = `${instanceId}:${spec.fingerprint}:${Date.now()}`;
    for (let attempt = 0; ; attempt += 1) {
      const lease = await this.leaseFor(instanceId);
      const response = await this.request(
        "POST",
        "/v1/runtimes",
        body,
        { ...this.leaseHeaders(lease), "Idempotency-Key": idempotencyKey },
        ENSURE_TIMEOUT_MS,
      );
      if (response.status === 200) {
        const runtime = response.json as Partial<GondolinRemoteRuntime>;
        if (
          typeof runtime.sessionId !== "string" ||
          runtime.sessionId.length === 0 ||
          typeof runtime.workerPid !== "number"
        ) {
          throw new SandboxError("Error: remote worker returned an invalid runtime response");
        }
        return {
          sessionId: runtime.sessionId,
          instanceId,
          workerPid: runtime.workerPid,
          fingerprint: spec.fingerprint,
        };
      }
      if (isLeaseFencedStatus(response.status) && attempt === 0) {
        this.dropLease(instanceId);
        continue;
      }
      throw new SandboxError(
        `Error: remote worker refused runtime (${response.status}): ${String(response.json.message ?? "")}`,
      );
    }
  }

  async stop(
    handle: Pick<GondolinRuntimeHandle, "workerPid" | "sessionId" | "instanceId">,
  ): Promise<void> {
    const lease = await this.leaseFor(handle.instanceId);
    const response = await this.request(
      "DELETE",
      `/v1/runtimes/${handle.sessionId}`,
      undefined,
      this.leaseHeaders(lease),
    );
    if (isLeaseFencedStatus(response.status)) {
      this.dropLease(handle.instanceId);
      throw new GondolinRuntimeGoneError(`runtime stop was lease-fenced (${response.status})`);
    }
    if (response.status !== 200) {
      throw new GondolinWorkerUnreachableError(
        `remote worker refused runtime stop (${response.status}): ${String(response.json.message ?? "")}`,
      );
    }
    this.releaseLease(handle.instanceId);
  }

  async isRuntimeAlive(handle: GondolinRuntimeHandle): Promise<boolean> {
    try {
      const response = await this.request("GET", `/v1/runtimes/${handle.sessionId}`);
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /** Live runtimes hosted by this worker (fleet reconciliation). */
  async listRuntimes(): Promise<Array<{ sessionId: string; instanceId: string }>> {
    const response = await this.request("GET", "/v1/runtimes");
    if (response.status !== 200) return [];
    const runtimes = response.json.runtimes;
    return Array.isArray(runtimes)
      ? (runtimes as Array<{ sessionId: string; instanceId: string }>)
      : [];
  }

  async exec(
    handle: GondolinRuntimeHandle,
    command: string,
    options: { env?: Record<string, string>; signal?: AbortSignal } = {},
  ): Promise<ExecResult> {
    const lease = this.leases.get(handle.instanceId);
    if (!lease) {
      // the lease lapsed (e.g. mikan slept); recreate the session cleanly
      throw new GondolinRuntimeGoneError("no live lease for this runtime");
    }
    return execOverSessionConnect(
      (callbacks) =>
        this.openTunnel(
          handle.instanceId,
          `/v1/runtimes/${handle.sessionId}/session`,
          this.leaseHeaders(lease),
          callbacks,
        ),
      command,
      options,
    );
  }

  /**
   * Split mounts for the remote worker:
   * - sources under the mikan-host workspace are translated to the worker's
   *   shared `workspaceRoot` (shared POSIX storage), and
   * - sources outside it that are files (vault credentials, which live in the
   *   host state dir, not the shared workspace) are read and shipped as
   *   content payloads for the worker to project into the guest.
   * A non-file source outside the workspace has nowhere to go and is dropped.
   */
  private translateMounts(spec: GondolinRuntimeSpec): {
    mounts: Array<{ source: string; target: string }>;
    credentialFiles: GondolinCredentialFile[];
  } {
    const root = this.settings.workspaceRoot;
    if (!root || !spec.workspacePath) {
      return { mounts: spec.mounts, credentialFiles: [] };
    }
    const mounts: Array<{ source: string; target: string }> = [];
    const credentialFiles: GondolinCredentialFile[] = [];
    for (const mount of spec.mounts) {
      const suffix = relative(spec.workspacePath, mount.source);
      if (!suffix.startsWith("..") && !isAbsolute(suffix)) {
        mounts.push({ source: join(root, suffix), target: mount.target });
        continue;
      }
      try {
        if (!statSync(mount.source).isFile()) {
          log.logWarning(
            `Skipping directory mount outside the shared workspace for remote runtime: ${mount.source}`,
          );
          continue;
        }
        credentialFiles.push({
          target: mount.target,
          contentBase64: readFileSync(mount.source).toString("base64"),
        });
      } catch {
        // missing source: skip, matching the local worker's behavior
      }
    }
    return { mounts, credentialFiles };
  }

  private async leaseFor(instanceId: string): Promise<RemoteLease> {
    const cached = this.leases.get(instanceId);
    if (cached) return cached;
    // Write-ahead the maximum lifetime before the worker can grant a lease.
    // A host crash after grant but before response must not expose an older
    // failover watermark from durable placement state.
    this.reportLeaseActivity(instanceId);
    const now = this.overrides.now ?? Date.now;
    const monotonicNow = this.overrides.monotonicNow ?? performance.now.bind(performance);
    const startedAt = now();
    const startedMonotonic = monotonicNow();
    const response = await this.request(
      "POST",
      "/v1/leases",
      {
        instanceId,
        ttlSeconds: this.leaseTtlSeconds,
      },
      undefined,
      LEASE_ACQUIRE_TIMEOUT_MS,
    );
    if (response.status !== 200) {
      throw new SandboxError(
        `Error: remote worker refused lease (${response.status}): ${String(response.json.message ?? "")}`,
      );
    }
    if (
      typeof response.json.id !== "string" ||
      response.json.id.length === 0 ||
      typeof response.json.epoch !== "number" ||
      !Number.isSafeInteger(response.json.epoch) ||
      response.json.epoch < 1 ||
      response.json.instanceId !== instanceId ||
      typeof response.json.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(response.json.expiresAt))
    ) {
      throw new SandboxError("Error: remote worker returned an invalid lease response");
    }
    this.validateClockSample(
      response.json.serverTime,
      startedAt,
      startedMonotonic,
      monotonicNow,
      (this.protocolVersion ?? 0) >= 2,
    );
    const lease: RemoteLease = {
      leaseId: response.json.id,
      epoch: response.json.epoch,
      renewTimer: setInterval(() => void this.renew(instanceId), (this.leaseTtlSeconds * 1000) / 3),
    };
    lease.renewTimer.unref?.();
    this.leases.set(instanceId, lease);
    return lease;
  }

  private async renew(instanceId: string): Promise<void> {
    const lease = this.leases.get(instanceId);
    if (!lease) return;
    try {
      const now = this.overrides.now ?? Date.now;
      const monotonicNow = this.overrides.monotonicNow ?? performance.now.bind(performance);
      const startedAt = now();
      const startedMonotonic = monotonicNow();
      // Write-ahead fence: persist the longest possible renewed lifetime on
      // the host before asking the worker to extend its lease. If persistence
      // fails, do not renew; a conservative watermark is always safe.
      this.reportLeaseActivity(instanceId);
      const response = await this.request("POST", `/v1/leases/${lease.leaseId}/renew`, {
        ttlSeconds: this.leaseTtlSeconds,
      });
      if (response.status !== 200) {
        this.dropLease(instanceId);
        return;
      }
      if (
        typeof response.json.id !== "string" ||
        response.json.id !== lease.leaseId ||
        response.json.epoch !== lease.epoch ||
        response.json.instanceId !== instanceId ||
        typeof response.json.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(response.json.expiresAt))
      ) {
        throw new SandboxError("Error: remote worker returned an invalid lease renewal response");
      }
      this.validateClockSample(
        response.json.serverTime,
        startedAt,
        startedMonotonic,
        monotonicNow,
        (this.protocolVersion ?? 0) >= 2,
      );
    } catch (err) {
      this.dropLease(instanceId);
      log.logWarning(
        `Failed to renew remote worker lease for '${instanceId}'`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private reportLeaseActivity(instanceId: string): void {
    // fencing watermark by mikan's own clock: the worker-side lease cannot
    // outlive this moment plus its ttl, no matter whose clock is skewed
    this.overrides.onLeaseActivity?.(
      instanceId,
      Date.now() + (this.leaseTtlSeconds + GONDOLIN_FENCING_GRACE_SECONDS) * 1000,
    );
  }

  private releaseLease(instanceId: string): void {
    const lease = this.leases.get(instanceId);
    if (!lease) return;
    this.dropLease(instanceId);
    void this.request("DELETE", `/v1/leases/${lease.leaseId}`).catch(() => {});
  }

  private dropLease(instanceId: string): void {
    const lease = this.leases.get(instanceId);
    if (!lease) return;
    clearInterval(lease.renewTimer);
    this.leases.delete(instanceId);
  }

  private leaseHeaders(lease: RemoteLease): Record<string, string> {
    return { "X-Mikan-Lease": lease.leaseId, "X-Mikan-Epoch": String(lease.epoch) };
  }

  private request(
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<RemoteResponse> {
    if (this.overrides.request) return this.overrides.request(method, path, body, headers);
    const url = new URL(path, this.settings.url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          method,
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": payload.length }
              : {}),
            ...headers,
          },
          ...this.tlsOptions(),
        },
        (response) => {
          let raw = "";
          let bytes = 0;
          let failed = false;
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            if (failed) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_RESPONSE_BYTES) {
              failed = true;
              response.destroy(
                new GondolinWorkerUnreachableError(
                  `remote worker response exceeds ${MAX_RESPONSE_BYTES} bytes`,
                ),
              );
              return;
            }
            raw += chunk;
          });
          response.on("error", (error: Error) => {
            if (!failed) reject(new GondolinWorkerUnreachableError(error.message));
            else reject(error);
          });
          response.on("end", () => {
            if (failed) return;
            let json: Record<string, unknown> = {};
            try {
              json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
            } catch {
              // non-JSON body; status carries the outcome
            }
            resolve({ status: response.statusCode ?? 0, json });
          });
        },
      );
      request.on("error", (error: Error) =>
        reject(new GondolinWorkerUnreachableError(error.message)),
      );
      if (payload) request.write(payload);
      request.end();
    });
  }

  private openTunnel(
    instanceId: string,
    path: string,
    headers: Record<string, string>,
    callbacks: SessionClientCallbacks,
  ): SessionClient | Promise<SessionClient> {
    if (this.overrides.tunnel) return this.overrides.tunnel(path, headers, callbacks);
    const url = new URL(path, this.settings.url);
    return new Promise((resolve, reject) => {
      const request = (this.overrides.httpsRequest ?? httpsRequest)({
        method: "GET",
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { ...headers, Connection: "Upgrade", Upgrade: "gondolin-session" },
        ...this.tlsOptions(),
      });
      const handshakeTimer = setTimeout(() => {
        request.destroy(new Error(`tunnel handshake timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      handshakeTimer.unref?.();
      request.on("upgrade", (_response, socket) => {
        clearTimeout(handshakeTimer);
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30_000);
        let closed = false;
        const parse = createSessionFrameParser(callbacks);
        socket.on("data", parse);
        socket.on("error", (error: Error) => {
          if (closed) return;
          closed = true;
          callbacks.onClose(error);
        });
        socket.on("close", () => {
          if (closed) return;
          closed = true;
          callbacks.onClose();
        });
        resolve({
          send: (message) => {
            if (!closed) socket.write(encodeSessionMessage(message));
          },
          close: () => {
            if (closed) return;
            closed = true;
            socket.destroy();
          },
        });
      });
      request.on("response", (response) => {
        clearTimeout(handshakeTimer);
        if (isLeaseFencedStatus(response.statusCode)) {
          this.dropLease(instanceId);
        }
        const error = new Error(
          `tunnel refused: HTTP ${response.statusCode}`,
        ) as NodeJS.ErrnoException;
        error.code = "ECONNREFUSED"; // nothing executed — safe to recreate and retry
        reject(error);
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(handshakeTimer);
        error.code ??= "ECONNREFUSED";
        reject(error);
      });
      request.end();
    });
  }

  private tlsOptions(): { ca?: Buffer; cert: Buffer; key: Buffer } {
    if (this.tls) return this.tls;
    if (!this.settings.certFile || !this.settings.keyFile) {
      throw new SandboxError(
        `Error: gondolin remote worker '${this.settings.name ?? this.settings.url}' needs certFile and keyFile`,
      );
    }
    this.tls = {
      ...(this.settings.caFile ? { ca: readFileSync(this.settings.caFile) } : {}),
      cert: readFileSync(this.settings.certFile),
      key: readFileSync(this.settings.keyFile),
    };
    return this.tls;
  }
}
