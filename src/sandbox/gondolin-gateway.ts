import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { hostname } from "node:os";
import { TLSSocket, createServer as createTlsServer } from "node:tls";
import * as log from "../log.js";
import { isRecord } from "../utils/file-guards.js";
import type { GondolinGatewaySettings } from "../types.js";
import { gondolinFleet } from "./gondolin-fleet.js";
import { gondolinJoin } from "./gondolin-join.js";
import { createSessionFrameParser, encodeSessionMessage } from "./gondolin-contract.js";
import {
  GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION,
  GONDOLIN_REMOTE_PROTOCOL_VERSION,
  GondolinRemoteConnection,
  GondolinWorkerUnreachableError,
} from "./gondolin-remote.js";
import type { SessionClient, SessionClientCallbacks } from "./gondolin-worker-client.js";

const RPC_TIMEOUT_MS = 150_000;
const TUNNEL_TIMEOUT_MS = 15_000;
const PREAMBLE_TIMEOUT_MS = 10_000;
const CONTROL_IDLE_TIMEOUT_MS = 45_000;
const MAX_PREAMBLE_FRAME_BYTES = 1 << 20;
const MAX_CONTROL_FRAME_BYTES = 8 << 20;

/** What a worker announces when it dials home (mirrors the Go register frame). */
interface GondolinWorkerRegistration {
  name: string;
  os?: string;
  arch?: string;
  accelerator?: string;
  cpus?: number;
  memoryBytes?: number;
  maxRuntimes?: number;
  protocolVersion?: number;
  runtimes?: Array<{ sessionId: string; instanceId: string }>;
  /** Non-empty when the worker's shared workspace failed its usability probe. */
  workspaceError?: string;
}

interface ControlFrame extends GondolinWorkerRegistration {
  type: string;
  id?: number;
  status?: number;
  body?: unknown;
  nonce?: string;
  message?: string;
  activeRuntimes?: number;
  /** join exchange */
  token?: string;
  csr?: string;
}

interface RegisteredWorker {
  info: GondolinWorkerRegistration;
  socket: Socket;
  connectedAt: number;
  lastSeen: number;
  activeRuntimes: number;
  workspaceError?: string;
  certificateExpiresAt?: number;
  pendingRpc: Map<
    number,
    {
      resolve: (frame: ControlFrame) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  nextRpcId: number;
  idleTimer: NodeJS.Timeout;
}

/**
 * Splits a byte stream into u32be-length-prefixed JSON frames, preserving any
 * bytes after the point where the consumer stops parsing (a tunnel connection
 * switches protocols after its preamble frame).
 */
function createControlFrameReader(
  onFrame: (frame: ControlFrame, leftover: Buffer) => void,
  onInvalid: () => void,
  maxFrameBytes: () => number = () => MAX_CONTROL_FRAME_BYTES,
): {
  push: (chunk: Buffer) => void;
  stop: () => void;
} {
  let buffer = Buffer.alloc(0);
  let stopped = false;
  return {
    push(chunk: Buffer) {
      if (stopped) return;
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        // onFrame may call stop() synchronously (a tunnel switching protocols)
        if (stopped || buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length > maxFrameBytes()) {
          stopped = true;
          buffer = Buffer.alloc(0);
          onInvalid();
          return;
        }
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let frame: ControlFrame;
        try {
          const parsed: unknown = JSON.parse(payload.toString("utf8"));
          if (!isRecord(parsed) || typeof parsed.type !== "string")
            throw new Error("invalid frame");
          frame = parsed as unknown as ControlFrame;
        } catch {
          stopped = true;
          buffer = Buffer.alloc(0);
          onInvalid();
          return;
        }
        onFrame(frame, buffer);
      }
    },
    stop() {
      stopped = true;
    },
  };
}

function encodeControlFrame(frame: object): Buffer {
  const encoded = encodeSessionMessage(frame);
  if (encoded.length - 4 > MAX_CONTROL_FRAME_BYTES) {
    throw new Error(`control frame exceeds ${MAX_CONTROL_FRAME_BYTES} bytes`);
  }
  return encoded;
}

interface GatewayOverrides {
  /** Server factory (tests substitute a plain net.Server). */
  createServer?: (onConnection: (socket: Socket) => void) => Server;
  /** mTLS verification result for a socket (tests substitute outcomes). */
  isAuthorized?: (socket: Socket) => boolean;
  /** Bind the claimed worker name to its authenticated certificate identity. */
  isWorkerNameAuthorized?: (
    socket: Socket,
    workerName: string,
    purpose: "register" | "tunnel",
  ) => boolean;
  activateWorkerCertificate?: (socket: Socket, workerName: string) => boolean;
  leaseTtlSeconds?: number;
  rpcTimeoutMs?: number;
  tunnelTimeoutMs?: number;
  preambleTimeoutMs?: number;
  controlIdleTimeoutMs?: number;
}

function defaultIsAuthorized(socket: Socket): boolean {
  return socket instanceof TLSSocket && socket.authorized;
}

function defaultIsWorkerNameAuthorized(
  socket: Socket,
  workerName: string,
  purpose: "register" | "tunnel",
): boolean {
  if (!(socket instanceof TLSSocket)) return false;
  const certificate = socket.getPeerCertificate();
  if (certificate.subject?.CN !== workerName || typeof certificate.fingerprint256 !== "string") {
    return false;
  }
  if (purpose === "register") {
    if (gondolinJoin.isIssuedWorkerCertificate(workerName, certificate.fingerprint256)) return true;
    return false;
  }
  return gondolinJoin.isActiveWorkerCertificate(workerName, certificate.fingerprint256);
}

function adoptLegacyWorkerCertificate(socket: Socket, workerName: string): boolean {
  if (!(socket instanceof TLSSocket)) return true;
  const fingerprint = socket.getPeerCertificate().fingerprint256;
  if (typeof fingerprint !== "string") return false;
  try {
    return gondolinJoin.adoptLegacyWorkerCertificate(workerName, fingerprint);
  } catch (error) {
    log.logWarning(
      `Gondolin legacy worker '${workerName}' identity adoption failed`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

function activateWorkerCertificate(socket: Socket, workerName: string): boolean {
  if (!(socket instanceof TLSSocket)) return true; // test servers inject authorization
  const fingerprint = socket.getPeerCertificate().fingerprint256;
  if (typeof fingerprint !== "string") return false;
  try {
    return gondolinJoin.activateWorkerCertificate(workerName, fingerprint);
  } catch (error) {
    log.logWarning(
      `Gondolin worker '${workerName}' certificate activation failed`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * The host side of dial-home workers: one mTLS listener that accepts worker
 * control channels (register/ping/RPC responses) and per-command dial-back
 * tunnels, keeps the registry of connected workers, and attaches each one to
 * the fleet as a regular worker connection. Placement, leases, fencing, and
 * failover are unchanged — this only reverses who dials whom.
 */
class GondolinWorkerGateway {
  private settings?: GondolinGatewaySettings;
  private overrides: GatewayOverrides = {};
  private server?: Server;
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly activeTunnels = new Set<Socket>();
  private readonly pendingTunnels = new Map<
    string,
    {
      workerName: string;
      resolve: (value: { socket: Socket; leftover: Buffer }) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  configure(settings?: GondolinGatewaySettings, overrides?: GatewayOverrides): void {
    this.stop();
    this.settings = settings;
    this.overrides = overrides ?? {};
  }

  isConfigured(): boolean {
    return this.settings !== undefined;
  }

  /** Registered workers and their liveness (admin/observability surface). */
  list(): Array<{
    name: string;
    connected: boolean;
    connectedAt: number;
    activeRuntimes: number;
    workspaceError?: string;
    certificateExpiresAt?: string;
    expiresWithin30Days?: boolean;
    info: GondolinWorkerRegistration;
  }> {
    return Array.from(this.workers.values()).map((worker) => ({
      name: worker.info.name,
      connected: !worker.socket.destroyed,
      connectedAt: worker.connectedAt,
      activeRuntimes: worker.activeRuntimes,
      workspaceError: worker.workspaceError,
      ...(worker.certificateExpiresAt !== undefined
        ? {
            certificateExpiresAt: new Date(worker.certificateExpiresAt).toISOString(),
            expiresWithin30Days: worker.certificateExpiresAt - Date.now() <= 30 * 24 * 3600 * 1000,
          }
        : {}),
      info: worker.info,
    }));
  }

  /**
   * Start the listener. Without explicit certificate settings the gateway
   * provisions its own: a private worker CA plus a server certificate signed
   * by it (required for join's CA pinning to also authenticate the host).
   */
  async start(): Promise<void> {
    if (!this.settings || this.server) return;
    const settings = this.settings;
    if (!settings.workspaceRoot) {
      // dial-home workers inherit workspaceRoot from here; without it every
      // runtime is rejected with "escapes the workspace root"
      throw new Error(
        "gondolin gateway requires workspaceRoot (the worker-side shared workspace path); " +
          "set sandbox.gondolin.remote.gateway.workspaceRoot",
      );
    }
    let material: { certFile: string; keyFile: string; clientCaFile: string };
    if (settings.certFile && settings.keyFile && settings.clientCaFile) {
      material = {
        certFile: settings.certFile,
        keyFile: settings.keyFile,
        clientCaFile: settings.clientCaFile,
      };
    } else {
      if (!gondolinJoin.isConfigured()) {
        throw new Error("gondolin gateway auto-init requires the join service to be configured");
      }
      const issued = await gondolinJoin.ensureServerCert(settings.hostnames ?? [hostname()]);
      material = { ...issued, clientCaFile: gondolinJoin.paths().caFile };
    }
    const factory =
      this.overrides.createServer ??
      ((onConnection: (socket: Socket) => void) =>
        createTlsServer(
          {
            cert: readFileSync(material.certFile),
            key: readFileSync(material.keyFile),
            ca: readFileSync(material.clientCaFile),
            requestCert: true,
            // unauthenticated connections may only send a join frame; the
            // per-frame authorization gate enforces that below
            rejectUnauthorized: false,
            minVersion: "TLSv1.3",
          },
          onConnection,
        ));
    this.server = factory((socket) => this.handleConnection(socket));
    this.server.listen(this.settings.port, () => {
      log.logInfo(`Gondolin worker gateway listening on :${this.settings?.port}`);
    });
  }

  stop(): void {
    for (const worker of this.workers.values()) {
      worker.socket.destroy();
      this.rejectPendingRpc(worker, "gateway stopped");
      gondolinFleet.detachWorker(worker.info.name);
    }
    this.workers.clear();
    this.rejectPendingTunnels(undefined, "gateway stopped");
    for (const socket of this.activeTunnels) socket.destroy();
    this.activeTunnels.clear();
    this.server?.close();
    this.server = undefined;
  }

  /** Routes one inbound connection by its first frame: control or tunnel. */
  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    const preambleTimer = setTimeout(
      () => socket.destroy(),
      this.overrides.preambleTimeoutMs ?? PREAMBLE_TIMEOUT_MS,
    );
    preambleTimer.unref?.();
    const clearPreambleTimer = (): void => clearTimeout(preambleTimer);
    socket.once("close", clearPreambleTimer);
    let routed = false;
    const authorized = (this.overrides.isAuthorized ?? defaultIsAuthorized)(socket);
    const workerNameAuthorized = (workerName: string, purpose: "register" | "tunnel"): boolean =>
      (this.overrides.isWorkerNameAuthorized ?? defaultIsWorkerNameAuthorized)(
        socket,
        workerName,
        purpose,
      );
    const reader = createControlFrameReader(
      (frame, leftover) => {
        if (!routed) {
          routed = true;
          clearPreambleTimer();
          if (frame.type === "join") {
            void this.handleJoin(socket, frame);
          } else if (!authorized) {
            // everything except join requires a CA-signed client certificate
            socket.destroy();
          } else if (frame.type === "register" && frame.name) {
            const identityAuthorized =
              workerNameAuthorized(frame.name, "register") ||
              (frame.protocolVersion === 1 && adoptLegacyWorkerCertificate(socket, frame.name));
            if (!identityAuthorized) {
              this.refuseRegistration(socket, "certificate is not active for this worker identity");
              return;
            }
            this.acceptControlChannel(socket, frame, reader);
          } else if (
            frame.type === "tunnel" &&
            frame.nonce &&
            frame.name &&
            workerNameAuthorized(frame.name, "tunnel")
          ) {
            reader.stop();
            socket.removeAllListeners("data");
            this.acceptTunnel(socket, frame.nonce, frame.name, leftover);
          } else {
            socket.destroy();
          }
          return;
        }
        this.handleControlFrame(socket, frame);
      },
      () => socket.destroy(),
      () => (routed ? MAX_CONTROL_FRAME_BYTES : MAX_PREAMBLE_FRAME_BYTES),
    );
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("error", () => socket.destroy());
  }

  private refuseRegistration(socket: Socket, message: string): void {
    log.logWarning(`Gondolin worker registration refused: ${message}`);
    socket.end(encodeControlFrame({ type: "register-error", message }));
    socket.destroySoon();
  }

  private acceptControlChannel(
    socket: Socket,
    registration: ControlFrame,
    _reader: { stop: () => void },
  ): void {
    const name = registration.name as string;
    if (
      typeof registration.protocolVersion !== "number" ||
      !Number.isInteger(registration.protocolVersion) ||
      registration.protocolVersion < GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION ||
      registration.protocolVersion > GONDOLIN_REMOTE_PROTOCOL_VERSION
    ) {
      log.logWarning(
        `Gondolin worker '${name}' rejected: incompatible protocol ` +
          `(supported ${GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION}-${GONDOLIN_REMOTE_PROTOCOL_VERSION}, got ${registration.protocolVersion ?? "missing"})`,
      );
      this.refuseRegistration(
        socket,
        `incompatible protocol (supported ${GONDOLIN_MIN_REMOTE_PROTOCOL_VERSION}-${GONDOLIN_REMOTE_PROTOCOL_VERSION}, got ${registration.protocolVersion ?? "missing"})`,
      );
      return;
    }
    if (
      registration.maxRuntimes !== undefined &&
      (!Number.isSafeInteger(registration.maxRuntimes) || registration.maxRuntimes < 1)
    ) {
      log.logWarning(`Gondolin worker '${name}' rejected: maxRuntimes must be a positive integer`);
      this.refuseRegistration(socket, "maxRuntimes must be a positive integer");
      return;
    }
    if (!(this.overrides.activateWorkerCertificate ?? activateWorkerCertificate)(socket, name)) {
      this.refuseRegistration(socket, "certificate identity activation failed");
      return;
    }
    const previous = this.workers.get(name);
    if (previous && !previous.socket.destroyed) {
      log.logInfo(`Gondolin worker '${name}' re-registered; superseding previous connection`);
      this.rejectPendingTunnels(name, `worker '${name}' re-registered`);
      previous.socket.destroy();
    }
    const peerCertificate = socket instanceof TLSSocket ? socket.getPeerCertificate() : undefined;
    const certificateExpiresAt = peerCertificate?.valid_to
      ? Date.parse(peerCertificate.valid_to)
      : Number.NaN;
    const worker: RegisteredWorker = {
      info: registration,
      socket,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      activeRuntimes: registration.runtimes?.length ?? 0,
      ...(Number.isFinite(certificateExpiresAt) ? { certificateExpiresAt } : {}),
      pendingRpc: new Map(),
      nextRpcId: 1,
      idleTimer: setTimeout(() => {}, 0),
    };
    clearTimeout(worker.idleTimer);
    worker.idleTimer = this.armControlIdleTimer(worker);
    this.workers.set(name, worker);
    socket.on("close", () => {
      clearTimeout(worker.idleTimer);
      this.rejectPendingRpc(worker, `worker '${name}' disconnected`);
      const current = this.workers.get(name);
      if (current !== worker) return; // superseded or rejected before acknowledgement
      log.logWarning(`Gondolin worker disconnected: ${name} (placements remain fenced)`);
      this.rejectPendingTunnels(name, `worker '${name}' disconnected`);
      gondolinFleet.detachWorker(name);
      this.workers.delete(name);
    });
    const surviving = registration.runtimes?.length ?? 0;
    log.logInfo(
      `Gondolin worker joined: ${name} (${registration.os}/${registration.arch}, ` +
        `${registration.accelerator}, ${registration.cpus} cpus, ` +
        `cap ${registration.maxRuntimes ?? "∞"}, ${surviving} runtimes surviving)`,
    );

    const overrides = this.settings?.workers?.[name];
    try {
      gondolinFleet.attachWorker(
        {
          name,
          url: `dialhome://${name}`,
          workspaceRoot: this.settings?.workspaceRoot,
          maxRuntimes: overrides?.maxRuntimes ?? registration.maxRuntimes,
          draining: overrides?.draining,
        },
        (connectionOverrides) =>
          new GondolinRemoteConnection(
            { name, url: `dialhome://${name}`, workspaceRoot: this.settings?.workspaceRoot },
            {
              ...connectionOverrides,
              ...(this.overrides.leaseTtlSeconds !== undefined
                ? { leaseTtlSeconds: this.overrides.leaseTtlSeconds }
                : {}),
              request: (method, path, body, headers) => this.rpc(name, method, path, body, headers),
              tunnel: (path, headers, callbacks) => this.openTunnel(name, path, headers, callbacks),
            },
          ),
      );
    } catch (error) {
      clearTimeout(worker.idleTimer);
      this.workers.delete(name);
      log.logWarning(
        `Gondolin worker '${name}' rejected`,
        error instanceof Error ? error.message : String(error),
      );
      this.refuseRegistration(socket, error instanceof Error ? error.message : String(error));
      return;
    }
    if (registration.protocolVersion >= 2) {
      socket.write(encodeControlFrame({ type: "register-ok" }));
    }
    this.applyWorkspaceHealth(worker, registration.workspaceError);
    if (worker.certificateExpiresAt !== undefined) {
      gondolinFleet.updateWorkerCertificateExpiry(name, worker.certificateExpiresAt);
    }
    // a worker that reconnected may carry runtimes whose placements moved
    void gondolinFleet.reconcile().catch((error: unknown) => {
      log.logWarning(
        `Gondolin fleet reconciliation after '${name}' registration failed`,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private handleControlFrame(socket: Socket, frame: ControlFrame): void {
    const worker = this.workerBySocket(socket);
    if (!worker) return;
    worker.lastSeen = Date.now();
    clearTimeout(worker.idleTimer);
    worker.idleTimer = this.armControlIdleTimer(worker);
    if (frame.type === "ping") {
      if (typeof frame.activeRuntimes === "number") {
        worker.activeRuntimes = frame.activeRuntimes;
      }
      // omitted on healthy pings (Go omitempty), so absence means recovered
      this.applyWorkspaceHealth(worker, frame.workspaceError);
      socket.write(encodeControlFrame({ type: "pong" }));
      return;
    }
    if (frame.type === "tunnel-error" && frame.nonce) {
      const pending = this.pendingTunnels.get(frame.nonce);
      if (!pending || pending.workerName !== worker.info.name) return;
      this.pendingTunnels.delete(frame.nonce);
      clearTimeout(pending.timer);
      const error = new Error(
        frame.message || `worker '${worker.info.name}' refused the tunnel`,
      ) as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED";
      pending.reject(error);
      return;
    }
    if (frame.type === "response" && typeof frame.id === "number") {
      const pending = worker.pendingRpc.get(frame.id);
      if (!pending) return;
      worker.pendingRpc.delete(frame.id);
      clearTimeout(pending.timer);
      pending.resolve(frame);
    }
  }

  private armControlIdleTimer(worker: RegisteredWorker): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.workers.get(worker.info.name) !== worker) return;
      log.logWarning(`Gondolin worker '${worker.info.name}' heartbeat timed out`);
      worker.socket.destroy();
    }, this.overrides.controlIdleTimeoutMs ?? CONTROL_IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  /**
   * Track shared-workspace health from register/ping frames and push it into
   * the fleet, logging only the transitions. A worker whose NFS mount died
   * keeps its control channel alive — this is what turns that silent state
   * into refused placements and fail-fast execs.
   */
  private applyWorkspaceHealth(worker: RegisteredWorker, error: string | undefined): void {
    const next = error || undefined;
    if (next === worker.workspaceError) {
      gondolinFleet.setWorkspaceHealth(worker.info.name, next); // attach may have reset it
      return;
    }
    if (next) {
      log.logWarning(
        `Gondolin worker '${worker.info.name}' workspace is unusable: ${next} — new placements disabled until it recovers`,
      );
    } else {
      log.logInfo(`Gondolin worker '${worker.info.name}' workspace recovered`);
    }
    worker.workspaceError = next;
    gondolinFleet.setWorkspaceHealth(worker.info.name, next);
  }

  /** RPC to a worker over its control channel (the reverse of HTTPS requests). */
  private rpc(
    name: string,
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const worker = this.workers.get(name);
    if (!worker || worker.socket.destroyed) {
      return Promise.reject(
        new GondolinWorkerUnreachableError(`worker '${name}' is not connected`),
      );
    }
    const id = worker.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timeoutMs =
        method === "GET" && path === "/v1/health"
          ? Math.min(this.overrides.rpcTimeoutMs ?? RPC_TIMEOUT_MS, 15_000)
          : (this.overrides.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      const timer = setTimeout(() => {
        worker.pendingRpc.delete(id);
        reject(
          new GondolinWorkerUnreachableError(
            `RPC to worker '${name}' timed out (${method} ${path})`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      worker.pendingRpc.set(id, {
        timer,
        reject,
        resolve: (frame) =>
          resolve({
            status: frame.status ?? 0,
            json: (frame.body ?? {}) as Record<string, unknown>,
          }),
      });
      worker.socket.write(encodeControlFrame({ type: "request", id, method, path, body, headers }));
    });
  }

  private rejectPendingRpc(worker: RegisteredWorker, reason: string): void {
    for (const pending of worker.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(new GondolinWorkerUnreachableError(reason));
    }
    worker.pendingRpc.clear();
  }

  /** Ask the worker to dial back a data connection for one session tunnel. */
  private openTunnel(
    name: string,
    path: string,
    headers: Record<string, string>,
    callbacks: SessionClientCallbacks,
  ): Promise<SessionClient> {
    const worker = this.workers.get(name);
    if (!worker || worker.socket.destroyed) {
      const error = new Error(`worker '${name}' is not connected`) as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED"; // nothing executed — safe to recreate
      return Promise.reject(error);
    }
    const sessionId = path.split("/")[3];
    const nonce = randomBytes(16).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTunnels.delete(nonce);
        const error = new Error(
          `worker '${name}' did not dial back a tunnel`,
        ) as NodeJS.ErrnoException;
        error.code = "ECONNREFUSED";
        reject(error);
      }, this.overrides.tunnelTimeoutMs ?? TUNNEL_TIMEOUT_MS);
      timer.unref?.();
      this.pendingTunnels.set(nonce, {
        workerName: name,
        timer,
        reject,
        resolve: ({ socket, leftover }) => {
          this.activeTunnels.add(socket);
          let closed = false;
          const parse = createSessionFrameParser(callbacks);
          if (leftover.length > 0) parse(leftover);
          socket.on("data", parse);
          socket.on("error", (error: Error) => {
            this.activeTunnels.delete(socket);
            if (closed) return;
            closed = true;
            callbacks.onClose(error);
          });
          socket.on("close", () => {
            this.activeTunnels.delete(socket);
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
              this.activeTunnels.delete(socket);
              socket.destroy();
            },
          });
        },
      });
      worker.socket.write(encodeControlFrame({ type: "open-tunnel", nonce, sessionId, headers }));
    });
  }

  /**
   * One-time token → CA-signed client certificate. The only operation an
   * unauthenticated connection may perform; the connection closes after the
   * response either way.
   */
  private async handleJoin(socket: Socket, frame: ControlFrame): Promise<void> {
    const refuse = (message: string): void => {
      log.logWarning(`Gondolin worker join refused: ${message}`);
      socket.end(encodeControlFrame({ type: "join-error", message }));
    };
    if (!gondolinJoin.isConfigured()) {
      refuse("join is not enabled on this gateway");
      return;
    }
    if (!frame.token || !frame.csr || !frame.name) {
      refuse("join requires token, csr, and name");
      return;
    }
    if (!gondolinJoin.validateToken(frame.token, frame.name)) {
      refuse(`invalid or expired join token (worker '${frame.name}')`);
      return;
    }
    try {
      await gondolinJoin.validateWorkerCsr(frame.csr, frame.name);
    } catch (err) {
      refuse(`invalid worker identity: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let consumed = false;
    try {
      consumed = gondolinJoin.consumeToken(frame.token, frame.name);
    } catch (error) {
      refuse(
        `join token state unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (!consumed) {
      refuse(`invalid or expired join token (worker '${frame.name}')`);
      return;
    }
    try {
      const signed = await gondolinJoin.signCsr(frame.csr, frame.name);
      log.logInfo(`Gondolin worker '${frame.name}' joined: client certificate issued`);
      socket.end(encodeControlFrame({ type: "join-ok", cert: signed.certPem, ca: signed.caPem }));
    } catch (err) {
      refuse(`certificate issuance failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private acceptTunnel(socket: Socket, nonce: string, workerName: string, leftover: Buffer): void {
    const pending = this.pendingTunnels.get(nonce);
    if (!pending || pending.workerName !== workerName) {
      socket.destroy();
      return;
    }
    this.pendingTunnels.delete(nonce);
    clearTimeout(pending.timer);
    pending.resolve({ socket, leftover: Buffer.from(leftover) });
  }

  private rejectPendingTunnels(workerName: string | undefined, reason: string): void {
    for (const [nonce, pending] of this.pendingTunnels) {
      if (workerName !== undefined && pending.workerName !== workerName) continue;
      this.pendingTunnels.delete(nonce);
      clearTimeout(pending.timer);
      const error = new Error(reason) as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED";
      pending.reject(error);
    }
  }

  private workerBySocket(socket: Socket): RegisteredWorker | undefined {
    for (const worker of this.workers.values()) {
      if (worker.socket === socket) return worker;
    }
    return undefined;
  }
}

export const gondolinGateway = new GondolinWorkerGateway();
