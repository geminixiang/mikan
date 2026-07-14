import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { relative, isAbsolute, join } from "node:path";
import * as log from "../log.js";
import type { GondolinRemoteSettings } from "../types.js";
import { SandboxError } from "./errors.js";
import {
  GondolinRuntimeGoneError,
  execOverSessionConnect,
  type GondolinRuntimeHandle,
  type GondolinRuntimeSpec,
  type GondolinRuntimeTransport,
  type SessionClient,
  type SessionClientCallbacks,
} from "./gondolin-worker-client.js";
import type { ExecResult } from "./types.js";

const LEASE_TTL_SECONDS = 300;

interface RemoteLease {
  leaseId: string;
  epoch: number;
  renewTimer: NodeJS.Timeout;
}

interface RemoteResponse {
  status: number;
  json: Record<string, unknown>;
}

interface GondolinRemoteOverrides {
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
}

/** Parses the daemon-to-client session framing: u8 type + u32be length + payload. */
export function createSessionFrameParser(
  callbacks: SessionClientCallbacks,
): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const type = buffer.readUInt8(0);
      const length = buffer.readUInt32BE(1);
      if (buffer.length < 5 + length) return;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (type === 1) {
        callbacks.onBinary(Buffer.from(payload));
        continue;
      }
      try {
        callbacks.onJson(JSON.parse(payload.toString("utf8")));
      } catch {
        // ignore malformed frames
      }
    }
  };
}

/** Encodes a client-to-daemon session message: u32be length + JSON. */
export function encodeSessionMessage(message: object): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Runs Gondolin runtimes on a remote mikan-worker daemon over mutual TLS.
 * Every runtime operation happens under a fenced lease on the instance id;
 * commands travel through one upgraded tunnel each, so abort semantics match
 * the local transport exactly.
 */
class GondolinRemoteClient implements GondolinRuntimeTransport {
  private settings?: GondolinRemoteSettings;
  private requestImpl?: GondolinRemoteOverrides["request"];
  private tunnelImpl?: GondolinRemoteOverrides["tunnel"];
  private leaseTtlSeconds = LEASE_TTL_SECONDS;
  private readonly leases = new Map<string, RemoteLease>();
  private tls?: { ca?: Buffer; cert: Buffer; key: Buffer };

  configure(settings?: GondolinRemoteSettings, overrides?: GondolinRemoteOverrides): void {
    this.settings = settings;
    this.requestImpl = overrides?.request;
    this.tunnelImpl = overrides?.tunnel;
    this.leaseTtlSeconds = overrides?.leaseTtlSeconds ?? LEASE_TTL_SECONDS;
    this.tls = undefined;
    for (const lease of this.leases.values()) clearInterval(lease.renewTimer);
    this.leases.clear();
  }

  isConfigured(): boolean {
    return this.settings !== undefined || this.requestImpl !== undefined;
  }

  imageSelector(): string | undefined {
    return this.settings?.imageSelector;
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
    const body = {
      instanceId,
      imageSelector: spec.image,
      mounts: this.translateMounts(spec),
      cpus: spec.cpus ?? "",
      memory: spec.memory ?? "",
      fingerprint: spec.fingerprint,
    };
    const idempotencyKey = `${instanceId}:${spec.fingerprint}:${Date.now()}`;
    for (let attempt = 0; ; attempt += 1) {
      const lease = await this.leaseFor(instanceId);
      const response = await this.request("POST", "/v1/runtimes", body, {
        ...this.leaseHeaders(lease),
        "Idempotency-Key": idempotencyKey,
      });
      if (response.status === 200) {
        return {
          sessionId: response.json.sessionId as string,
          instanceId,
          socketPath: "",
          workerPid: (response.json.workerPid as number) ?? 0,
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

  private translateMounts(spec: GondolinRuntimeSpec): Array<{ source: string; target: string }> {
    const root = this.settings?.workspaceRoot;
    if (!root || !spec.workspacePath) return spec.mounts;
    const translated: Array<{ source: string; target: string }> = [];
    for (const mount of spec.mounts) {
      const suffix = relative(spec.workspacePath, mount.source);
      if (suffix.startsWith("..") || isAbsolute(suffix)) {
        log.logWarning(
          `Skipping mount outside the shared workspace for remote runtime: ${mount.source}`,
        );
        continue;
      }
      translated.push({ source: join(root, suffix), target: mount.target });
    }
    return translated;
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
    return lease;
  }

  private async renew(instanceId: string): Promise<void> {
    const lease = this.leases.get(instanceId);
    if (!lease) return;
    try {
      const response = await this.request("POST", `/v1/leases/${lease.leaseId}/renew`, {
        ttlSeconds: this.leaseTtlSeconds,
      });
      if (response.status !== 200) this.dropLease(instanceId);
    } catch (err) {
      log.logWarning(
        `Failed to renew remote worker lease for '${instanceId}'`,
        err instanceof Error ? err.message : String(err),
      );
    }
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
  ): Promise<RemoteResponse> {
    if (this.requestImpl) return this.requestImpl(method, path, body, headers);
    const settings = this.requireSettings();
    const url = new URL(path, settings.url);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          method,
          host: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
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
      request.on("error", reject);
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
    if (this.tunnelImpl) return this.tunnelImpl(path, headers, callbacks);
    const settings = this.requireSettings();
    const url = new URL(path, settings.url);
    return new Promise((resolve, reject) => {
      const request = httpsRequest({
        method: "GET",
        host: url.hostname,
        port: url.port,
        path: url.pathname,
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
    const settings = this.requireSettings();
    this.tls = {
      ...(settings.caFile ? { ca: readFileSync(settings.caFile) } : {}),
      cert: readFileSync(settings.certFile),
      key: readFileSync(settings.keyFile),
    };
    return this.tls;
  }

  private requireSettings(): GondolinRemoteSettings {
    if (!this.settings) {
      throw new SandboxError(
        "Error: gondolin:remote requires sandbox.gondolin.remote settings (url, certFile, keyFile)",
      );
    }
    return this.settings;
  }
}

export const gondolinRemote = new GondolinRemoteClient();
