import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { hostname } from "node:os";
import { TLSSocket, createServer as createTlsServer } from "node:tls";
import * as log from "../log.js";
import type { GondolinGatewaySettings } from "../types.js";
import { gondolinFleet } from "./gondolin-fleet.js";
import { gondolinJoin } from "./gondolin-join.js";
import {
  GondolinRemoteConnection,
  GondolinWorkerUnreachableError,
  createSessionFrameParser,
  encodeSessionMessage,
} from "./gondolin-remote.js";
import type { SessionClient, SessionClientCallbacks } from "./gondolin-worker-client.js";

const RPC_TIMEOUT_MS = 150_000;
const TUNNEL_TIMEOUT_MS = 15_000;

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
}

interface ControlFrame extends GondolinWorkerRegistration {
  type: string;
  id?: number;
  status?: number;
  body?: unknown;
  nonce?: string;
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
  pendingRpc: Map<number, { resolve: (frame: ControlFrame) => void; timer: NodeJS.Timeout }>;
  nextRpcId: number;
}

/**
 * Splits a byte stream into u32be-length-prefixed JSON frames, preserving any
 * bytes after the point where the consumer stops parsing (a tunnel connection
 * switches protocols after its preamble frame).
 */
function createControlFrameReader(onFrame: (frame: ControlFrame, leftover: Buffer) => void): {
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
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let frame: ControlFrame;
        try {
          frame = JSON.parse(payload.toString("utf8")) as ControlFrame;
        } catch {
          continue; // skip malformed frames
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
  return encodeSessionMessage(frame);
}

interface GatewayOverrides {
  /** Server factory (tests substitute a plain net.Server). */
  createServer?: (onConnection: (socket: Socket) => void) => Server;
  /** mTLS verification result for a socket (tests substitute outcomes). */
  isAuthorized?: (socket: Socket) => boolean;
  leaseTtlSeconds?: number;
  rpcTimeoutMs?: number;
  tunnelTimeoutMs?: number;
}

function defaultIsAuthorized(socket: Socket): boolean {
  return socket instanceof TLSSocket && socket.authorized;
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
  private readonly pendingTunnels = new Map<
    string,
    { resolve: (value: { socket: Socket; leftover: Buffer }) => void; timer: NodeJS.Timeout }
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
    activeRuntimes: number;
    info: GondolinWorkerRegistration;
  }> {
    return Array.from(this.workers.values()).map((worker) => ({
      name: worker.info.name,
      connected: !worker.socket.destroyed,
      activeRuntimes: worker.activeRuntimes,
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
      for (const pending of worker.pendingRpc.values()) clearTimeout(pending.timer);
    }
    this.workers.clear();
    for (const pending of this.pendingTunnels.values()) clearTimeout(pending.timer);
    this.pendingTunnels.clear();
    this.server?.close();
    this.server = undefined;
  }

  /** Routes one inbound connection by its first frame: control or tunnel. */
  private handleConnection(socket: Socket): void {
    socket.setNoDelay(true);
    let routed = false;
    const authorized = (this.overrides.isAuthorized ?? defaultIsAuthorized)(socket);
    const reader = createControlFrameReader((frame, leftover) => {
      if (!routed) {
        routed = true;
        if (frame.type === "join") {
          void this.handleJoin(socket, frame);
        } else if (!authorized) {
          // everything except join requires a CA-signed client certificate
          socket.destroy();
        } else if (frame.type === "register" && frame.name) {
          this.acceptControlChannel(socket, frame, reader);
        } else if (frame.type === "tunnel" && frame.nonce) {
          reader.stop();
          socket.removeAllListeners("data");
          this.acceptTunnel(socket, frame.nonce, leftover);
        } else {
          socket.destroy();
        }
        return;
      }
      this.handleControlFrame(socket, frame);
    });
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("error", () => socket.destroy());
  }

  private acceptControlChannel(
    socket: Socket,
    registration: ControlFrame,
    _reader: { stop: () => void },
  ): void {
    const name = registration.name as string;
    const previous = this.workers.get(name);
    if (previous && !previous.socket.destroyed) {
      log.logInfo(`Gondolin worker '${name}' re-registered; superseding previous connection`);
      previous.socket.destroy();
    }
    const worker: RegisteredWorker = {
      info: registration,
      socket,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      activeRuntimes: registration.runtimes?.length ?? 0,
      pendingRpc: new Map(),
      nextRpcId: 1,
    };
    this.workers.set(name, worker);
    const surviving = registration.runtimes?.length ?? 0;
    log.logInfo(
      `Gondolin worker joined: ${name} (${registration.os}/${registration.arch}, ` +
        `${registration.accelerator}, ${registration.cpus} cpus, ` +
        `cap ${registration.maxRuntimes ?? "∞"}, ${surviving} runtimes surviving)`,
    );

    const overrides = this.settings?.workers?.[name];
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
    // a worker that reconnected may carry runtimes whose placements moved
    void gondolinFleet.reconcile();

    socket.on("close", () => {
      const current = this.workers.get(name);
      if (current !== worker) return; // superseded
      for (const pending of worker.pendingRpc.values()) clearTimeout(pending.timer);
      worker.pendingRpc.clear();
      log.logWarning(`Gondolin worker disconnected: ${name} (placements fence until lease expiry)`);
      gondolinFleet.detachWorker(name);
      this.workers.delete(name);
    });
  }

  private handleControlFrame(socket: Socket, frame: ControlFrame): void {
    const worker = this.workerBySocket(socket);
    if (!worker) return;
    worker.lastSeen = Date.now();
    if (frame.type === "ping") {
      if (typeof frame.activeRuntimes === "number") {
        worker.activeRuntimes = frame.activeRuntimes;
      }
      socket.write(encodeControlFrame({ type: "pong" }));
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
      const timer = setTimeout(() => {
        worker.pendingRpc.delete(id);
        reject(
          new GondolinWorkerUnreachableError(
            `RPC to worker '${name}' timed out (${method} ${path})`,
          ),
        );
      }, this.overrides.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
      timer.unref?.();
      worker.pendingRpc.set(id, {
        timer,
        resolve: (frame) =>
          resolve({
            status: frame.status ?? 0,
            json: (frame.body ?? {}) as Record<string, unknown>,
          }),
      });
      worker.socket.write(encodeControlFrame({ type: "request", id, method, path, body, headers }));
    });
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
        timer,
        resolve: ({ socket, leftover }) => {
          let closed = false;
          const parse = createSessionFrameParser(callbacks);
          if (leftover.length > 0) parse(leftover);
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
    if (!gondolinJoin.consumeToken(frame.token)) {
      refuse(`invalid or expired join token (worker '${frame.name}')`);
      return;
    }
    try {
      const signed = await gondolinJoin.signCsr(frame.csr);
      log.logInfo(`Gondolin worker '${frame.name}' joined: client certificate issued`);
      socket.end(encodeControlFrame({ type: "join-ok", cert: signed.certPem, ca: signed.caPem }));
    } catch (err) {
      refuse(`certificate issuance failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private acceptTunnel(socket: Socket, nonce: string, leftover: Buffer): void {
    const pending = this.pendingTunnels.get(nonce);
    if (!pending) {
      socket.destroy();
      return;
    }
    this.pendingTunnels.delete(nonce);
    clearTimeout(pending.timer);
    pending.resolve({ socket, leftover: Buffer.from(leftover) });
  }

  private workerBySocket(socket: Socket): RegisteredWorker | undefined {
    for (const worker of this.workers.values()) {
      if (worker.socket === socket) return worker;
    }
    return undefined;
  }
}

export const gondolinGateway = new GondolinWorkerGateway();
