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
import {
  GondolinRuntimeGoneError,
  execOverSessionConnect,
  type GondolinRuntimeHandle,
  type GondolinRuntimeSpec,
  type SessionClient,
  type SessionClientCallbacks,
} from "./gondolin-worker-client.js";
import type { ExecResult } from "./types.js";

const LEASE_TTL_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 15_000;
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
  leaseTtlSeconds?: number;
  requestTimeoutMs?: number;
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
  private tls?: { ca?: Buffer; cert: Buffer; key: Buffer };

  constructor(
    private readonly settings: GondolinRemoteWorkerSettings,
    private readonly overrides: GondolinRemoteOverrides = {},
  ) {
    this.leaseTtlSeconds = overrides.leaseTtlSeconds ?? LEASE_TTL_SECONDS;
    this.requestTimeoutMs = overrides.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Drop lease timers and caches (does not touch the daemon). */
  dispose(): void {
    for (const lease of this.leases.values()) clearInterval(lease.renewTimer);
    this.leases.clear();
  }

  async health(): Promise<Record<string, unknown>> {
    const response = await this.request("GET", "/v1/health");
    if (response.status !== 200) {
      throw new SandboxError(
        `Error: gondolin remote worker health check failed (${response.status})`,
      );
    }
    return response.json;
  }

  async ensure(instanceId: string, spec: GondolinRuntimeSpec): Promise<GondolinRuntimeHandle> {
    const { mounts, credentialFiles } = this.translateMounts(spec);
    const body: GondolinEnsureRuntimeRequest = {
      instanceId,
      imageSelector: spec.image,
      mounts,
      credentialFiles,
      cpus: spec.cpus ?? "",
      memory: spec.memory ?? "",
      fingerprint: spec.fingerprint,
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
        return {
          sessionId: runtime.sessionId ?? "",
          instanceId,
          socketPath: "",
          workerPid: runtime.workerPid ?? 0,
          fingerprint: spec.fingerprint,
        };
      }
      if ((response.status === 409 || response.status === 410) && attempt === 0) {
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
    if (response.status === 409 || response.status === 410) {
      this.dropLease(handle.instanceId);
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
    const response = await this.request("POST", "/v1/leases", {
      instanceId,
      ttlSeconds: this.leaseTtlSeconds,
    });
    if (response.status !== 200) {
      throw new SandboxError(
        `Error: remote worker refused lease (${response.status}): ${String(response.json.message ?? "")}`,
      );
    }
    const lease: RemoteLease = {
      leaseId: response.json.id as string,
      epoch: response.json.epoch as number,
      renewTimer: setInterval(() => void this.renew(instanceId), (this.leaseTtlSeconds * 1000) / 3),
    };
    lease.renewTimer.unref?.();
    this.leases.set(instanceId, lease);
    this.reportLeaseActivity(instanceId);
    return lease;
  }

  private async renew(instanceId: string): Promise<void> {
    const lease = this.leases.get(instanceId);
    if (!lease) return;
    try {
      const response = await this.request("POST", `/v1/leases/${lease.leaseId}/renew`, {
        ttlSeconds: this.leaseTtlSeconds,
      });
      if (response.status === 200) this.reportLeaseActivity(instanceId);
      else this.dropLease(instanceId);
    } catch (err) {
      log.logWarning(
        `Failed to renew remote worker lease for '${instanceId}'`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private reportLeaseActivity(instanceId: string): void {
    // fencing watermark by mikan's own clock: the worker-side lease cannot
    // outlive this moment plus its ttl, no matter whose clock is skewed
    this.overrides.onLeaseActivity?.(instanceId, Date.now() + this.leaseTtlSeconds * 1000);
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
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            raw += chunk;
          });
          response.on("end", () => {
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
      const request = httpsRequest({
        method: "GET",
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        headers: { ...headers, Connection: "Upgrade", Upgrade: "gondolin-session" },
        ...this.tlsOptions(),
      });
      request.on("upgrade", (_response, socket) => {
        socket.setNoDelay(true);
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
        if (response.statusCode === 409 || response.statusCode === 410) {
          this.dropLease(instanceId);
        }
        const error = new Error(
          `tunnel refused: HTTP ${response.statusCode}`,
        ) as NodeJS.ErrnoException;
        error.code = "ECONNREFUSED"; // nothing executed — safe to recreate and retry
        reject(error);
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
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
