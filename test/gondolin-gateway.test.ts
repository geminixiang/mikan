import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { gondolinFleet } from "../src/sandbox/gondolin-fleet.js";
import { gondolinGateway } from "../src/sandbox/gondolin-gateway.js";
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

/** A scripted dial-home worker speaking the wire protocol over TCP. */
class FakeDialhomeWorker extends EventEmitter {
  control!: Socket;
  requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  epochs = new Map<string, number>();
  leases = new Map<string, { instanceId: string; epoch: number }>();
  runtime?: { sessionId: string; instanceId: string; fingerprint: string };
  nextSession = 0;
  execResponse = { stdout: "ok", code: 0 };

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
            protocolVersion: 1,
            runtimes: this.surviving,
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
      const { status, body } = this.serve(frame);
      this.control.write(encodeFrame({ type: "response", id: frame.id, status, body }));
    } else if (frame.type === "open-tunnel") {
      this.emit("open-tunnel", frame);
      if (this.runtime?.sessionId === frame.sessionId) {
        this.dialBackTunnel(frame.nonce as string);
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
      return { status: 200, body: { activeRuntimes: this.runtime ? 1 : 0 } };
    }
    if (method === "POST" && path === "/v1/leases") {
      const instanceId = body?.instanceId as string;
      const epoch = (this.epochs.get(instanceId) ?? 0) + 1;
      this.epochs.set(instanceId, epoch);
      const id = `lease-${instanceId}-${epoch}`;
      this.leases.set(id, { instanceId, epoch });
      return { status: 200, body: { id, epoch, instanceId } };
    }
    if (method === "POST" && path?.endsWith("/renew")) {
      return { status: 200, body: {} };
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
        if (message.type === "exec") {
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

  close(): void {
    this.control.destroy();
  }
}

describe("Gondolin worker gateway", () => {
  let dir: string;
  let placements: GondolinPlacementStore;
  let port: number;
  let workers: FakeDialhomeWorker[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "gondolin-gateway-"));
    placements = new GondolinPlacementStore();
    placements.configure(join(dir, "placement.json"));
    workers = [];

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
        workers: { drained: { draining: true } },
      },
      {
        // plain TCP for tests; production wraps the same handler in mTLS
        createServer: (onConnection) => createServer(onConnection) as Server,
        rpcTimeoutMs: 2000,
        tunnelTimeoutMs: 2000,
      },
    );
    gondolinGateway.start();
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
});
