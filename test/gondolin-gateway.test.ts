import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateSandbox } from "../src/sandbox/index.js";
import { assertRemoteConfigured } from "../src/sandbox/gondolin.js";
import { gondolinFleet } from "../src/sandbox/gondolin-fleet.js";
import { gondolinGateway } from "../src/sandbox/gondolin-gateway.js";
import { gondolinJoin } from "../src/sandbox/gondolin-join.js";
import { GondolinPlacementStore } from "../src/sandbox/gondolin-placement.js";
import type { GondolinRuntimeSpec } from "../src/sandbox/gondolin-worker-client.js";

const SPEC: GondolinRuntimeSpec = {
  image: "mikan-sandbox:latest",
  mounts: [],
  fingerprint: "fp-1",
};

function encodeFrame(frame: object): Buffer {
  const payload = Buffer.from(JSON.stringify(frame));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function makeCsr(): string {
  const csrDir = mkdtempSync(join(tmpdir(), "csr-"));
  execFileSync("openssl", [
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-keyout",
    join(csrDir, "key.pem"),
    "-out",
    join(csrDir, "worker.csr"),
    "-nodes",
    "-subj",
    "/CN=joiner",
  ]);
  const csr = readFileSync(join(csrDir, "worker.csr"), "utf8");
  rmSync(csrDir, { recursive: true, force: true });
  return csr;
}

/** A scripted dial-home worker speaking the wire protocol over TCP. */
class FakeDialhomeWorker extends EventEmitter {
  control!: Socket;
  requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  epochs = new Map<string, number>();
  leases = new Map<string, { instanceId: string; epoch: number }>();
  runtime?: { sessionId: string; instanceId: string; fingerprint: string };
  nextSession = 0;
  execResponse = { stdout: "ok", code: 0 };
  workspaceError?: string;
  respondToRequests = true;
  respondToTunnels = true;
  respondToExec = true;

  constructor(
    readonly port: number,
    readonly name: string,
    readonly surviving: Array<{ sessionId: string; instanceId: string }> = [],
  ) {
    super();
  }

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.control = connect(this.port, "127.0.0.1", () => {
        this.control.write(
          encodeFrame({
            type: "register",
            name: this.name,
            os: "linux",
            arch: "amd64",
            accelerator: "kvm",
            cpus: 8,
            maxRuntimes: 4,
            protocolVersion: 2,
            runtimes: this.surviving,
            ...(this.workspaceError ? { workspaceError: this.workspaceError } : {}),
          }),
        );
        resolve();
      });
      let buffer = Buffer.alloc(0);
      this.control.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (buffer.length < 4 + length) return;
          const frame = JSON.parse(buffer.subarray(4, 4 + length).toString());
          buffer = buffer.subarray(4 + length);
          this.handleFrame(frame);
        }
      });
    });
  }

  private handleFrame(frame: {
    type: string;
    id?: number;
    method?: string;
    path?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
    nonce?: string;
    sessionId?: string;
  }): void {
    if (frame.type === "request") {
      this.requests.push({
        method: frame.method as string,
        path: frame.path as string,
        body: frame.body,
      });
      if (this.respondToRequests) {
        const { status, body } = this.serve(frame);
        this.control.write(encodeFrame({ type: "response", id: frame.id, status, body }));
      }
    } else if (frame.type === "open-tunnel") {
      this.emit("open-tunnel", frame);
      if (this.respondToTunnels && this.runtime?.sessionId === frame.sessionId) {
        this.dialBackTunnel(frame.nonce as string);
      } else if (this.respondToTunnels) {
        this.control.write(
          encodeFrame({ type: "tunnel-error", nonce: frame.nonce, message: "runtime unavailable" }),
        );
      }
    }
  }

  private serve(frame: {
    method?: string;
    path?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  }): {
    status: number;
    body: Record<string, unknown>;
  } {
    const { method, path, body } = frame;
    if (method === "GET" && path === "/v1/health") {
      return {
        status: 200,
        body: {
          protocolVersion: 2,
          serverTime: new Date().toISOString(),
          activeRuntimes: this.runtime ? 1 : 0,
        },
      };
    }
    if (method === "POST" && path === "/v1/leases") {
      const instanceId = body?.instanceId as string;
      const epoch = (this.epochs.get(instanceId) ?? 0) + 1;
      this.epochs.set(instanceId, epoch);
      const id = `lease-${instanceId}-${epoch}`;
      this.leases.set(id, { instanceId, epoch });
      return {
        status: 200,
        body: {
          id,
          epoch,
          instanceId,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          serverTime: new Date().toISOString(),
        },
      };
    }
    if (method === "POST" && path?.endsWith("/renew")) {
      const id = path.split("/")[3];
      const active = this.leases.get(id);
      if (!active) return { status: 404, body: {} };
      return {
        status: 200,
        body: {
          id,
          ...active,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          serverTime: new Date().toISOString(),
        },
      };
    }
    if (method === "DELETE" && path?.startsWith("/v1/leases/")) {
      return { status: 200, body: {} };
    }
    if (method === "POST" && path === "/v1/runtimes") {
      this.nextSession += 1;
      this.runtime = {
        sessionId: `${this.name}-s${this.nextSession}`,
        instanceId: body?.instanceId as string,
        fingerprint: body?.fingerprint as string,
      };
      return {
        status: 200,
        body: { sessionId: this.runtime.sessionId, workerPid: 9000 + this.nextSession },
      };
    }
    if (method === "GET" && path?.startsWith("/v1/runtimes/")) {
      const sessionId = path.split("/")[3];
      return this.runtime?.sessionId === sessionId
        ? { status: 200, body: {} }
        : { status: 404, body: {} };
    }
    if (method === "DELETE" && path?.startsWith("/v1/runtimes/")) {
      this.runtime = undefined;
      return { status: 200, body: { stopped: true } };
    }
    return { status: 404, body: {} };
  }

  private dialBackTunnel(nonce: string): void {
    const tunnel = connect(this.port, "127.0.0.1", () => {
      tunnel.write(encodeFrame({ type: "tunnel", nonce, name: this.name }));
    });
    let buffer = Buffer.alloc(0);
    tunnel.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
        buffer = buffer.subarray(4 + length);
        if (message.type === "exec" && this.respondToExec) {
          // binary stdout frame then exec_response, per the session protocol
          const stdout = Buffer.from(this.execResponse.stdout);
          const binary = Buffer.alloc(5 + 5 + stdout.length);
          binary.writeUInt8(1, 0);
          binary.writeUInt32BE(5 + stdout.length, 1);
          binary.writeUInt8(1, 5);
          binary.writeUInt32BE(message.id, 6);
          stdout.copy(binary, 10);
          tunnel.write(binary);
          const response = Buffer.from(
            JSON.stringify({
              type: "exec_response",
              id: message.id,
              exit_code: this.execResponse.code,
            }),
          );
          const jsonFrame = Buffer.alloc(5 + response.length);
          jsonFrame.writeUInt8(0, 0);
          jsonFrame.writeUInt32BE(response.length, 1);
          response.copy(jsonFrame, 5);
          tunnel.write(jsonFrame);
        }
      }
    });
  }

  sendPing(fields: { workspaceError?: string } = {}): void {
    this.control.write(
      encodeFrame({ type: "ping", activeRuntimes: this.runtime ? 1 : 0, ...fields }),
    );
  }

  close(): void {
    this.control.destroy();
  }
}

describe("Gondolin worker gateway", () => {
  let dir: string;
  let placements: GondolinPlacementStore;
  let port: number;
  let workers: FakeDialhomeWorker[];
  let activateCertificate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-gateway-"));
    placements = new GondolinPlacementStore();
    placements.configure(join(dir, "placement.json"));
    workers = [];
    activateCertificate = vi.fn(() => true);

    gondolinFleet.configure(
      { imageSelector: "mikan-sandbox:latest", queueWaitSeconds: 1, workers: [] },
      { placements, queuePollMs: 5 },
    );
    gondolinGateway.configure(
      {
        port: 0,
        certFile: "/unused.pem",
        keyFile: "/unused-key.pem",
        clientCaFile: "/unused-ca.pem",
        workspaceRoot: "/srv/workspace",
        workers: { drained: { draining: true } },
      },
      {
        // plain TCP for tests; production wraps the same handler in mTLS
        createServer: (onConnection) => createServer(onConnection) as Server,
        isAuthorized: () => true,
        isWorkerNameAuthorized: () => true,
        activateWorkerCertificate: activateCertificate,
        rpcTimeoutMs: 2000,
        tunnelTimeoutMs: 2000,
        preambleTimeoutMs: 50,
      },
    );
    await gondolinGateway.start();
    await vi.waitFor(() => {
      const address = (gondolinGateway as unknown as { server?: Server }).server?.address();
      if (typeof address !== "object" || address === null) throw new Error("not listening");
      port = address.port;
    });
  });

  afterEach(() => {
    for (const worker of workers) worker.close();
    gondolinGateway.configure();
    gondolinFleet.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  async function joinWorker(
    name: string,
    surviving: Array<{ sessionId: string; instanceId: string }> = [],
  ) {
    const worker = new FakeDialhomeWorker(port, name, surviving);
    workers.push(worker);
    await worker.connect();
    await vi.waitFor(() =>
      expect(gondolinGateway.list().some((entry) => entry.name === name)).toBe(true),
    );
    return worker;
  }

  test("closes connections that never send a preamble", async () => {
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });
    expect(gondolinGateway.list()).toEqual([]);
  });

  test("rejects workers with a missing or incompatible protocol version", async () => {
    for (const protocolVersion of [undefined, 3]) {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          encodeFrame({
            type: "register",
            name: `incompatible-${String(protocolVersion)}`,
            protocolVersion,
          }),
        );
      });
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
          resolve(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString()));
        });
        socket.on("error", reject);
      });
      expect(response.type).toBe("register-error");
      socket.destroy();
    }
    expect(gondolinGateway.list()).toEqual([]);
    expect(activateCertificate).not.toHaveBeenCalled();
  });

  test("accepts protocol v1 workers during a host-first rolling upgrade", async () => {
    const worker = new FakeDialhomeWorker(port, "rolling-v1");
    workers.push(worker);
    worker.connect = () =>
      new Promise((resolve) => {
        worker.control = connect(port, "127.0.0.1", () => {
          worker.control.write(
            encodeFrame({
              type: "register",
              name: "rolling-v1",
              protocolVersion: 1,
              maxRuntimes: 1,
            }),
          );
          resolve();
        });
      });

    await worker.connect();
    await vi.waitFor(() =>
      expect(gondolinGateway.list().some((entry) => entry.name === "rolling-v1")).toBe(true),
    );
  });

  test("rejects workers with invalid advertised capacity", async () => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        encodeFrame({ type: "register", name: "bad-cap", protocolVersion: 2, maxRuntimes: 0 }),
      );
    });
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
        resolve(JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString()));
      });
      socket.on("error", reject);
    });
    expect(response).toMatchObject({ type: "register-error", message: expect.any(String) });
    socket.destroy();
    expect(gondolinGateway.list()).toEqual([]);
    expect(activateCertificate).not.toHaveBeenCalled();
  });

  test("rejects oversized preamble frames before buffering their payload", async () => {
    const socket = connect(port, "127.0.0.1", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE((1 << 20) + 1);
      socket.write(header);
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("close", () => resolve());
      socket.on("error", reject);
    });
    expect(gondolinGateway.list()).toEqual([]);
  });

  test("rejects malformed or structurally invalid control frames", async () => {
    for (const payload of [Buffer.from("not-json"), Buffer.from("null"), Buffer.from("{}")]) {
      const socket = connect(port, "127.0.0.1", () => {
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length);
        socket.write(
          Buffer.concat([header, payload, encodeFrame({ type: "register", name: "x" })]),
        );
      });
      await new Promise<void>((resolve, reject) => {
        socket.on("close", () => resolve());
        socket.on("error", reject);
      });
    }
    expect(gondolinGateway.list()).toEqual([]);
  });

  test("a registering worker joins the fleet and serves a full command", async () => {
    const worker = await joinWorker("linux-1");

    const handle = await gondolinFleet.ensure("c1", SPEC);
    expect(handle.workerName).toBe("linux-1");
    expect(placements.get("c1")?.worker).toBe("linux-1");

    const result = await gondolinFleet.exec(handle, "echo hi");
    expect(result).toEqual({ stdout: "ok", stderr: "", code: 0 });

    // lease + ensure travelled over the control channel as RPC frames
    expect(worker.requests.map((request) => request.path)).toEqual(
      expect.arrayContaining(["/v1/leases", "/v1/runtimes"]),
    );

    // tunnel carried the lease fencing headers
    const tunnelFrames: Array<{ headers?: Record<string, string> }> = [];
    worker.on("open-tunnel", (frame) => tunnelFrames.push(frame));
    await gondolinFleet.exec(handle, "echo again");
    expect(tunnelFrames[0].headers?.["X-Mikan-Lease"]).toMatch(/^lease-/);
  });

  test("disconnects a registered worker whose control channel goes idle", async () => {
    (
      gondolinGateway as unknown as { overrides: { controlIdleTimeoutMs?: number } }
    ).overrides.controlIdleTimeoutMs = 50;
    await joinWorker("linux-1");
    await vi.waitFor(() => expect(gondolinGateway.list()).toHaveLength(0), { timeout: 1000 });
    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(
      "no gondolin remote worker is reachable",
    );
  });

  test("registration info is logged into the registry", async () => {
    await joinWorker("linux-1", [{ sessionId: "s-old", instanceId: "c9" }]);

    const [entry] = gondolinGateway.list();
    expect(entry).toMatchObject({
      name: "linux-1",
      connected: true,
      activeRuntimes: 1,
      info: { os: "linux", arch: "amd64", accelerator: "kvm", maxRuntimes: 4 },
    });
  });

  test("disconnect detaches the worker; exec fails until it reconnects", async () => {
    const worker = await joinWorker("linux-1");
    const handle = await gondolinFleet.ensure("c1", SPEC);

    worker.close();
    await vi.waitFor(() =>
      expect(gondolinGateway.list().some((entry) => entry.name === "linux-1")).toBe(false),
    );
    await expect(gondolinFleet.exec(handle, "echo hi")).rejects.toThrow();

    // reconnect: same name, surviving runtime reported
    const reborn = new FakeDialhomeWorker(port, "linux-1", [
      { sessionId: "linux-1-s1", instanceId: "c1" },
    ]);
    reborn.runtime = { sessionId: "linux-1-s1", instanceId: "c1", fingerprint: "fp-1" };
    workers.push(reborn);
    await reborn.connect();
    await vi.waitFor(() =>
      expect(gondolinGateway.list().some((entry) => entry.name === "linux-1")).toBe(true),
    );

    const again = await gondolinFleet.ensure("c1", SPEC);
    expect(again.workerName).toBe("linux-1");
  });

  test("disconnect rejects an in-flight RPC instead of leaving it pending", async () => {
    const worker = await joinWorker("linux-1");
    worker.respondToRequests = false;

    const pending = gondolinFleet.ensure("c1", SPEC);
    await vi.waitFor(() => expect(worker.requests.length).toBeGreaterThan(0));
    worker.close();

    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("in-flight RPC remained pending")), 500);
    });
    await expect(Promise.race([pending, deadline])).rejects.toThrow(
      "no gondolin remote worker is reachable",
    );
    clearTimeout(timeout);
  });

  test("worker tunnel refusal reaches the caller immediately", async () => {
    const worker = await joinWorker("linux-1");
    const handle = await gondolinFleet.ensure("c1", SPEC);
    worker.runtime = undefined;

    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("tunnel refusal was not forwarded")), 500);
    });
    await expect(Promise.race([gondolinFleet.exec(handle, "echo hi"), deadline])).rejects.toThrow(
      "runtime unavailable",
    );
    clearTimeout(timeout);
  });

  test("disconnect rejects a pending tunnel immediately", async () => {
    const worker = await joinWorker("linux-1");
    const handle = await gondolinFleet.ensure("c1", SPEC);
    worker.respondToTunnels = false;

    const pending = gondolinFleet.exec(handle, "echo hi");
    await new Promise<void>((resolve) => worker.once("open-tunnel", () => resolve()));
    worker.close();

    let timeout: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("pending tunnel remained open")), 500);
    });
    await expect(Promise.race([pending, deadline])).rejects.toThrow("disconnected");
    clearTimeout(timeout);
  });

  test("a tunnel can only be completed by its requested worker", async () => {
    const worker = await joinWorker("linux-1");
    const handle = await gondolinFleet.ensure("c1", SPEC);
    worker.respondToTunnels = false;

    let request: { nonce?: string } | undefined;
    const pending = gondolinFleet.exec(handle, "echo hi");
    await new Promise<void>((resolve) =>
      worker.once("open-tunnel", (frame) => {
        request = frame;
        resolve();
      }),
    );

    const impostor = connect(port, "127.0.0.1", () => {
      impostor.write(encodeFrame({ type: "tunnel", nonce: request?.nonce, name: "linux-2" }));
    });
    await new Promise<void>((resolve) => impostor.once("close", () => resolve()));

    worker.respondToTunnels = true;
    (worker as unknown as { dialBackTunnel: (nonce: string) => void }).dialBackTunnel(
      request?.nonce as string,
    );
    await expect(pending).resolves.toEqual({ stdout: "ok", stderr: "", code: 0 });
  });

  test("stopping the gateway interrupts active command tunnels", async () => {
    const worker = await joinWorker("linux-1");
    const handle = await gondolinFleet.ensure("c1", SPEC);
    worker.respondToExec = false;
    const command = gondolinFleet.exec(handle, "sleep 60");
    await new Promise<void>((resolve) => worker.once("open-tunnel", () => resolve()));
    await vi.waitFor(() =>
      expect(
        (gondolinGateway as unknown as { activeTunnels: Set<Socket> }).activeTunnels.size,
      ).toBe(1),
    );

    gondolinGateway.stop();

    await expect(command).rejects.toThrow(/connection closed/);
    expect((gondolinGateway as unknown as { activeTunnels: Set<Socket> }).activeTunnels.size).toBe(
      0,
    );
  });

  test("stopping the gateway detaches its workers from the fleet", async () => {
    await joinWorker("linux-1");
    gondolinGateway.stop();

    await expect(gondolinFleet.ensure("after-stop", SPEC)).rejects.toThrow(
      "no gondolin remote worker is reachable",
    );
  });

  test("a new registration under the same name supersedes the old connection", async () => {
    const first = await joinWorker("linux-1");
    const second = new FakeDialhomeWorker(port, "linux-1");
    workers.push(second);
    await second.connect();

    await vi.waitFor(() => expect(first.control.destroyed).toBe(true));
    const entries = gondolinGateway.list().filter((entry) => entry.name === "linux-1");
    expect(entries).toHaveLength(1);
  });

  test("host-side overrides mark a dial-home worker as draining", async () => {
    await joinWorker("drained");
    await joinWorker("linux-2");

    const handle = await gondolinFleet.ensure("c1", SPEC);
    expect(handle.workerName).toBe("linux-2");
  });

  test("placement sticks to the dial-home worker across ensures", async () => {
    await joinWorker("linux-1");
    await joinWorker("linux-2");

    const first = await gondolinFleet.ensure("c1", SPEC);
    for (let i = 0; i < 3; i += 1) {
      const again = await gondolinFleet.ensure("c1", SPEC);
      expect(again.workerName).toBe(first.workerName);
    }
  });

  test("registering with a workspace error disables placement with the diagnosis", async () => {
    const worker = new FakeDialhomeWorker(port, "nfs-dead");
    worker.workspaceError = "workspace root /mnt/mikan-workspace is not responding";
    workers.push(worker);
    await worker.connect();
    await vi.waitFor(() =>
      expect(gondolinGateway.list().some((entry) => entry.name === "nfs-dead")).toBe(true),
    );

    await expect(gondolinFleet.ensure("c1", SPEC)).rejects.toThrow(
      /degraded: 'nfs-dead': workspace root \/mnt\/mikan-workspace is not responding/,
    );
    const [entry] = gondolinGateway.list();
    expect(entry.workspaceError).toContain("not responding");
  });

  test("pings toggle workspace health while the worker stays connected", async () => {
    const worker = await joinWorker("linux-1");
    const handle = await gondolinFleet.ensure("c1", SPEC);

    worker.sendPing({ workspaceError: "workspace root /mnt/x is not responding" });
    await vi.waitFor(() =>
      expect(gondolinGateway.list()[0].workspaceError).toContain("not responding"),
    );
    await expect(gondolinFleet.exec(handle, "pwd")).rejects.toThrow(/unusable shared workspace/);

    worker.sendPing({}); // healthy pings omit the field — recovery
    await vi.waitFor(() => expect(gondolinGateway.list()[0].workspaceError).toBeUndefined());
    const result = await gondolinFleet.exec(handle, "echo hi");
    expect(result.code).toBe(0);
  });
});

describe("Gondolin worker gateway join + authorization", () => {
  let dir: string;
  let port: number;
  let authorized: boolean;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-gateway-join-"));
    authorized = true;
    gondolinJoin.configure(join(dir, "gateway"), { tokenTtlSeconds: 60 });
    gondolinFleet.configure(
      { imageSelector: "mikan-sandbox:latest", workers: [] },
      { placements: new GondolinPlacementStore(), queuePollMs: 5 },
    );
    gondolinGateway.configure(
      { port: 0, workspaceRoot: "/srv/workspace" }, // no cert settings: exercises auto-init via the join service
      {
        createServer: (onConnection) => createServer(onConnection) as Server,
        isAuthorized: () => authorized,
        isWorkerNameAuthorized: (_socket, workerName) => workerName === "joiner",
        rpcTimeoutMs: 2000,
      },
    );
    await gondolinGateway.start();
    await vi.waitFor(() => {
      const address = (gondolinGateway as unknown as { server?: Server }).server?.address();
      if (typeof address !== "object" || address === null) throw new Error("not listening");
      port = address.port;
    });
  });

  afterEach(() => {
    gondolinGateway.configure();
    gondolinFleet.configure();
    gondolinJoin.configure();
    rmSync(dir, { recursive: true, force: true });
  });

  function exchange(frame: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write(encodeFrame(frame)));
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        resolve(JSON.parse(buffer.subarray(4, 4 + length).toString()));
        socket.destroy();
      });
      socket.on("close", () => reject(new Error("closed without response")));
      socket.on("error", reject);
    });
  }

  test("a valid token gets a CA-signed certificate; reuse is refused", async () => {
    const minted = await gondolinJoin.mintToken();
    const csr = makeCsr();

    authorized = false; // join must work without a client certificate
    const response = await exchange({ type: "join", token: minted.token, name: "joiner", csr });
    expect(response.type).toBe("join-ok");

    const certificate = new X509Certificate(response.cert as string);
    const ca = new X509Certificate(response.ca as string);
    expect(certificate.subject).toContain("CN=joiner");
    expect(certificate.checkIssued(ca)).toBe(true);
    expect(`sha256:${ca.fingerprint256.replaceAll(":", "").toLowerCase()}`).toBe(
      minted.fingerprint,
    );

    const replay = await exchange({ type: "join", token: minted.token, name: "joiner-2", csr });
    expect(replay.type).toBe("join-error");
  });

  test("an invalid CSR does not consume the one-time token", async () => {
    const minted = await gondolinJoin.mintToken();
    authorized = false;

    const refused = await exchange({
      type: "join",
      token: minted.token,
      name: "different-name",
      csr: makeCsr(),
    });
    expect(refused.type).toBe("join-error");
    expect(refused.message).toContain("common name must match");

    const accepted = await exchange({
      type: "join",
      token: minted.token,
      name: "joiner",
      csr: makeCsr(),
    });
    expect(accepted.type).toBe("join-ok");
  });

  test("authorized certificates receive an explicit identity refusal", async () => {
    authorized = true;
    const response = await exchange({
      type: "register",
      name: "other-worker",
      protocolVersion: 2,
    });
    expect(response).toMatchObject({
      type: "register-error",
      message: "certificate is not active for this worker identity",
    });
  });

  test("unauthorized connections cannot register or tunnel", async () => {
    authorized = false;
    await expect(exchange({ type: "register", name: "sneaky", maxRuntimes: 1 })).rejects.toThrow(
      "closed without response",
    );
    await expect(exchange({ type: "tunnel", nonce: "x" })).rejects.toThrow(
      "closed without response",
    );
  });
});

describe("gondolin:remote startup validation ordering", () => {
  afterEach(() => {
    gondolinFleet.configure();
    gondolinGateway.configure();
  });

  test("validate does not require configuration (it runs before configure)", async () => {
    gondolinFleet.configure();
    gondolinGateway.configure();
    // main.ts calls validateSandbox before the transports are configured, so
    // this must not throw despite nothing being wired yet
    await expect(validateSandbox({ type: "gondolin", profile: "remote" })).resolves.toBeUndefined();
  });

  test("assertRemoteConfigured guards after configure — gateway alone suffices", () => {
    gondolinFleet.configure();
    gondolinGateway.configure();
    expect(() => assertRemoteConfigured()).toThrow("requires sandbox.gondolin.remote settings");

    gondolinGateway.configure({ port: 0, certFile: "a", keyFile: "b", clientCaFile: "c" });
    expect(() => assertRemoteConfigured()).not.toThrow();
  });
});
