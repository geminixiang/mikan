import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import type { RequestOptions } from "node:https";
import { Socket } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionFrameParser, encodeSessionMessage } from "../src/sandbox/gondolin-remote.js";
import { gondolinFleet } from "../src/sandbox/gondolin-fleet.js";
import {
  GONDOLIN_REMOTE_PROTOCOL_VERSION,
  GondolinRemoteConnection,
} from "../src/sandbox/gondolin-remote.js";
import { GondolinPlacementStore } from "../src/sandbox/gondolin-placement.js";
import {
  GondolinExecutor,
  configureGondolinNetworkPolicy,
  disconnectAllGondolinRuntimes,
  gondolinResources,
  stopIdleGondolinVms,
} from "../src/sandbox/gondolin.js";
import type {
  SessionClient,
  SessionClientCallbacks,
} from "../src/sandbox/gondolin-worker-client.js";

interface FakeCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface FakeExec {
  command: string;
  env: string[];
  respond: (code: number, stdout?: string) => void;
  drop: () => void;
}

/** In-memory daemon: leases with epochs plus a single runtime slot. */
class FakeDaemon {
  calls: FakeCall[] = [];
  epochs = new Map<string, number>();
  leases = new Map<string, { instanceId: string; epoch: number }>();
  runtime?: { sessionId: string; instanceId: string; fingerprint: string };
  execs: FakeExec[] = [];
  nextSession = 0;
  refuseTunnel = 0;
  refuseStop = 0;
  invalidEnsureResponse = false;
  invalidLeaseResponse = false;
  failRenew = false;
  invalidRenewResponse = false;

  request = async (
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const call = { method, path, body: body as Record<string, unknown>, headers };
    this.calls.push(call);
    if (method === "GET" && path === "/v1/health") {
      return {
        status: 200,
        json: {
          protocolVersion: GONDOLIN_REMOTE_PROTOCOL_VERSION,
          serverTime: new Date().toISOString(),
          activeRuntimes: this.runtime ? 1 : 0,
        },
      };
    }
    if (method === "POST" && path === "/v1/leases") {
      const instanceId = call.body?.instanceId as string;
      const epoch = (this.epochs.get(instanceId) ?? 0) + 1;
      this.epochs.set(instanceId, epoch);
      const id = `lease-${instanceId}-${epoch}`;
      this.leases.set(id, { instanceId, epoch });
      return this.invalidLeaseResponse
        ? { status: 200, json: {} }
        : {
            status: 200,
            json: {
              id,
              epoch,
              instanceId,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              serverTime: new Date().toISOString(),
            },
          };
    }
    if (method === "POST" && path.endsWith("/renew")) {
      if (this.failRenew) throw new Error("renew transport failed");
      const id = path.split("/")[3];
      const activeLease = this.leases.get(id);
      if (this.invalidRenewResponse && activeLease) {
        return { status: 200, json: { id, epoch: activeLease.epoch } };
      }
      return activeLease
        ? {
            status: 200,
            json: {
              id,
              epoch: activeLease.epoch,
              instanceId: activeLease.instanceId,
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
              serverTime: new Date().toISOString(),
            },
          }
        : { status: 404, json: {} };
    }
    if (method === "DELETE" && path.startsWith("/v1/leases/")) {
      this.leases.delete(path.split("/")[3]);
      return { status: 200, json: {} };
    }
    if (method === "POST" && path === "/v1/runtimes") {
      const authorized = this.authorize(call);
      if (authorized !== 200) return { status: authorized, json: { message: "fenced" } };
      this.nextSession += 1;
      this.runtime = {
        sessionId: `remote-${this.nextSession}`,
        instanceId: call.body?.instanceId as string,
        fingerprint: call.body?.fingerprint as string,
      };
      return {
        status: 200,
        json: this.invalidEnsureResponse
          ? {}
          : { sessionId: this.runtime.sessionId, workerPid: 7000 + this.nextSession },
      };
    }
    if (method === "GET" && path.startsWith("/v1/runtimes/")) {
      const sessionId = path.split("/")[3];
      return this.runtime?.sessionId === sessionId
        ? { status: 200, json: {} }
        : { status: 404, json: {} };
    }
    if (method === "DELETE" && path.startsWith("/v1/runtimes/")) {
      if (this.refuseStop > 0) {
        this.refuseStop -= 1;
        return { status: 500, json: { message: "stop failed" } };
      }
      this.runtime = undefined;
      return { status: 200, json: { stopped: true } };
    }
    return { status: 404, json: {} };
  };

  tunnel = (
    path: string,
    headers: Record<string, string>,
    callbacks: SessionClientCallbacks,
  ): SessionClient => {
    const sessionId = path.split("/")[3];
    if (
      this.refuseTunnel > 0 ||
      this.runtime?.sessionId !== sessionId ||
      Number(headers["X-Mikan-Epoch"]) !== this.epochs.get(this.runtime.instanceId)
    ) {
      if (this.refuseTunnel > 0) this.refuseTunnel -= 1;
      const error = new Error("tunnel refused") as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED";
      queueMicrotask(() => callbacks.onClose(error));
      return { send: () => {}, close: () => {} };
    }
    let open = true;
    return {
      send: (message: { type?: string; id?: number; argv?: string[]; env?: string[] }) => {
        if (!open || message.type !== "exec") return;
        const exec: FakeExec = {
          command: message.argv?.[1] ?? "",
          env: message.env ?? [],
          respond: (code, stdout = "ok") => {
            if (!open) return;
            const payload = Buffer.from(stdout);
            const frame = Buffer.alloc(5 + payload.length);
            frame.writeUInt8(1, 0);
            frame.writeUInt32BE(message.id ?? 1, 1);
            payload.copy(frame, 5);
            callbacks.onBinary(frame);
            callbacks.onJson({ type: "exec_response", id: message.id ?? 1, exit_code: code });
          },
          drop: () => callbacks.onClose(),
        };
        this.execs.push(exec);
        queueMicrotask(() => exec.respond(0));
      },
      close: () => {
        open = false;
      },
    };
  };

  private authorize(call: FakeCall): number {
    const leaseId = call.headers?.["X-Mikan-Lease"];
    const epoch = Number(call.headers?.["X-Mikan-Epoch"]);
    const lease = leaseId ? this.leases.get(leaseId) : undefined;
    if (!lease) return 401;
    const current = this.epochs.get(lease.instanceId) ?? 0;
    if (epoch < current) return 409;
    return 200;
  }
}

function createRemoteExecutor(instanceId: string, env?: Record<string, string>): GondolinExecutor {
  return new GondolinExecutor(
    {
      type: "gondolin",
      profile: "remote",
      instanceId,
      workspacePath: "/host/workspace",
      mounts: [
        { source: "/host/workspace/C123", target: "/workspace/C123" },
        { source: "/host/state/vaults/c123/.ssh", target: "/root/.ssh" },
      ],
    },
    env,
  );
}

describe("Gondolin remote transport", () => {
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  let daemon: FakeDaemon;

  beforeEach(() => {
    daemon = new FakeDaemon();
    gondolinResources.configure();
    const placements = new GondolinPlacementStore();
    placements.configure();
    gondolinFleet.configure(
      {
        url: "https://worker.test:8433",
        certFile: "/unused.pem",
        keyFile: "/unused-key.pem",
        workspaceRoot: "/srv/workspace",
        imageSelector: "mikan-sandbox:latest",
      },
      {
        placements,
        connectionOverrides: {
          request: daemon.request,
          tunnel: daemon.tunnel,
          leaseTtlSeconds: 300,
        },
      },
    );
    // remote profile must not require the gondolin Node floor on the host
    Object.defineProperty(process.versions, "node", { value: "22.19.0", configurable: true });
  });

  afterEach(async () => {
    await disconnectAllGondolinRuntimes();
    configureGondolinNetworkPolicy();
    gondolinFleet.configure();
    if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
    vi.restoreAllMocks();
  });

  test("static tunnel handshake timeout is cleared after upgrade", async () => {
    const request = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.end = vi.fn();
    request.destroy = vi.fn();
    const socket = new Socket();
    const tlsDir = mkdtempSync(join(tmpdir(), "gondolin-static-tls-"));
    const certFile = join(tlsDir, "cert.pem");
    const keyFile = join(tlsDir, "key.pem");
    writeFileSync(certFile, "test");
    writeFileSync(keyFile, "test");
    const connection = new GondolinRemoteConnection(
      { name: "static", url: "https://worker.test:8433", certFile, keyFile },
      {
        requestTimeoutMs: 20,
        httpsRequest: ((_options: string | URL | RequestOptions) =>
          request as unknown as ClientRequest) as typeof import("node:https").request,
      },
    );
    const callbacks: SessionClientCallbacks = {
      onJson: () => {},
      onBinary: () => {},
      onClose: () => {},
    };
    const pending = (
      connection as unknown as {
        openTunnel: (
          instanceId: string,
          path: string,
          headers: Record<string, string>,
          callbacks: SessionClientCallbacks,
        ) => Promise<SessionClient>;
      }
    ).openTunnel("c1", "/v1/runtimes/s1/session", {}, callbacks);

    request.emit("upgrade", {}, socket);
    const client = await pending;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(request.destroy).not.toHaveBeenCalled();
    client.close();
    rmSync(tlsDir, { recursive: true, force: true });
  });

  test("static tunnel handshake timeout destroys a connection that never upgrades", async () => {
    const tlsDir = mkdtempSync(join(tmpdir(), "gondolin-static-timeout-"));
    const certFile = join(tlsDir, "cert.pem");
    const keyFile = join(tlsDir, "key.pem");
    writeFileSync(certFile, "test");
    writeFileSync(keyFile, "test");
    const request = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    request.end = vi.fn();
    request.destroy = vi.fn((error: Error) => request.emit("error", error));
    const connection = new GondolinRemoteConnection(
      { name: "static", url: "https://worker.test:8433", certFile, keyFile },
      {
        requestTimeoutMs: 20,
        httpsRequest: (() =>
          request as unknown as ClientRequest) as typeof import("node:https").request,
      },
    );
    const pending = (
      connection as unknown as {
        openTunnel: (
          instanceId: string,
          path: string,
          headers: Record<string, string>,
          callbacks: SessionClientCallbacks,
        ) => Promise<SessionClient>;
      }
    ).openTunnel(
      "c1",
      "/v1/runtimes/s1/session",
      {},
      {
        onJson: () => {},
        onBinary: () => {},
        onClose: () => {},
      },
    );

    await expect(pending).rejects.toThrow("tunnel handshake timed out");
    expect(request.destroy).toHaveBeenCalledOnce();
    rmSync(tlsDir, { recursive: true, force: true });
  });

  test("rejects an incompatible static worker protocol during health check", async () => {
    const connection = new GondolinRemoteConnection(
      { name: "old", url: "https://worker.test:8433" },
      {
        request: async () => ({
          status: 200,
          json: { protocolVersion: GONDOLIN_REMOTE_PROTOCOL_VERSION + 1 },
        }),
      },
    );

    await expect(connection.health()).rejects.toThrow(
      `supported 1-${GONDOLIN_REMOTE_PROTOCOL_VERSION}, got ${GONDOLIN_REMOTE_PROTOCOL_VERSION + 1}`,
    );
  });

  test("rejects protocol-v2 workers with unsafe clock skew", async () => {
    const connection = new GondolinRemoteConnection(
      { name: "skewed", url: "https://worker.test:8433" },
      {
        request: async () => ({
          status: 200,
          json: {
            protocolVersion: GONDOLIN_REMOTE_PROTOCOL_VERSION,
            serverTime: new Date(Date.now() + 60_000).toISOString(),
          },
        }),
      },
    );

    await expect(connection.health()).rejects.toThrow("synchronize host clocks");
  });

  test("rejects health samples whose RTT cannot establish clock safety", async () => {
    let monotonic = 0;
    const connection = new GondolinRemoteConnection(
      { name: "slow", url: "https://worker.test:8433" },
      {
        now: () => 1_000_000,
        monotonicNow: () => {
          const value = monotonic;
          monotonic += 6_000;
          return value;
        },
        request: async () => ({
          status: 200,
          json: {
            protocolVersion: GONDOLIN_REMOTE_PROTOCOL_VERSION,
            serverTime: new Date(1_003_000).toISOString(),
          },
        }),
      },
    );

    await expect(connection.health()).rejects.toThrow("too slow to verify clock safety");
  });

  test("rejects protocol-v2 workers without a valid server time", async () => {
    const connection = new GondolinRemoteConnection(
      { name: "missing-clock", url: "https://worker.test:8433" },
      {
        request: async () => ({
          status: 200,
          json: { protocolVersion: GONDOLIN_REMOTE_PROTOCOL_VERSION },
        }),
      },
    );

    await expect(connection.health()).rejects.toThrow("invalid server time");
  });

  test("accepts the previous static worker protocol during rolling upgrades", async () => {
    const connection = new GondolinRemoteConnection(
      { name: "rolling", url: "https://worker.test:8433" },
      { request: async () => ({ status: 200, json: { protocolVersion: 1 } }) },
    );

    await expect(connection.health()).resolves.toMatchObject({ protocolVersion: 1 });
  });

  test("does not silently send network policy to a protocol-v1 worker", async () => {
    let ensured = false;
    const connection = new GondolinRemoteConnection(
      { name: "rolling", url: "https://worker.test:8433" },
      {
        request: async (method, path) => {
          if (method === "GET" && path === "/v1/health") {
            return { status: 200, json: { protocolVersion: 1 } };
          }
          ensured = true;
          return { status: 500, json: {} };
        },
      },
    );

    await expect(
      connection.ensure("c1", {
        image: "mikan-sandbox:latest",
        mounts: [],
        fingerprint: "fp",
        network: { blockInternalRanges: true },
      }),
    ).rejects.toThrow("network policy requires remote worker protocol 2");
    expect(ensured).toBe(false);
  });

  test("ensure verifies protocol compatibility even without a fleet health pass", async () => {
    let ensured = false;
    const connection = new GondolinRemoteConnection(
      { name: "old", url: "https://worker.test:8433" },
      {
        request: async (method, path) => {
          if (method === "GET" && path === "/v1/health") {
            return {
              status: 200,
              json: { protocolVersion: GONDOLIN_REMOTE_PROTOCOL_VERSION + 1 },
            };
          }
          ensured = true;
          return { status: 500, json: {} };
        },
      },
    );

    await expect(
      connection.ensure("c1", {
        image: "mikan-sandbox:latest",
        mounts: [],
        fingerprint: "fp",
        workspacePath: "/host/workspace",
      }),
    ).rejects.toThrow("incompatible gondolin remote worker protocol");
    expect(ensured).toBe(false);
  });

  test("acquires a lease and ensures the runtime with translated mounts", async () => {
    const executor = createRemoteExecutor("remote-basic");

    const result = await executor.exec("pwd");

    expect(result).toEqual({ stdout: "ok", stderr: "", code: 0 });
    const ensure = daemon.calls.find((call) => call.path === "/v1/runtimes");
    expect(ensure?.headers?.["X-Mikan-Lease"]).toMatch(/^lease-/);
    expect(ensure?.body).toMatchObject({
      instanceId: "remote-basic",
      imageSelector: "mikan-sandbox:latest",
      heartbeatStaleMs: 150_000,
      // workspace mounts translate to the worker-side root; the directory-shaped
      // vault mount outside the shared workspace has no payload transport and is
      // dropped (needs shared storage)
      mounts: [{ source: "/srv/workspace/C123", target: "/workspace/C123" }],
    });
  });

  test("ships an explicit egress policy to remote runtimes", async () => {
    configureGondolinNetworkPolicy({
      blockInternalRanges: true,
      allowedHosts: [" API.GitHub.com "],
      allowedInternalHosts: [],
    });
    const executor = createRemoteExecutor("remote-network-policy");

    await executor.exec("true");

    const ensure = daemon.calls.find((call) => call.path === "/v1/runtimes");
    expect(ensure?.body?.network).toEqual({
      blockInternalRanges: true,
      allowedHosts: ["api.github.com"],
      allowedInternalHosts: [],
    });
  });

  test("rejects duplicate or empty egress host patterns at configuration", () => {
    expect(() =>
      configureGondolinNetworkPolicy({ allowedHosts: ["API.github.com", "api.github.com"] }),
    ).toThrow("duplicate host patterns");
    expect(() =>
      configureGondolinNetworkPolicy({
        blockInternalRanges: true,
        allowedInternalHosts: [" "],
      }),
    ).toThrow("empty host pattern");
    expect(() =>
      configureGondolinNetworkPolicy({ allowedInternalHosts: ["internal.test"] }),
    ).toThrow("requires blockInternalRanges: true");
  });

  test("rejects an invalid successful lease response", async () => {
    daemon.invalidLeaseResponse = true;
    const executor = createRemoteExecutor("invalid-lease");

    await expect(executor.exec("pwd")).rejects.toThrow("invalid lease response");
  });

  test("rejects an invalid successful runtime response", async () => {
    daemon.invalidEnsureResponse = true;
    const executor = createRemoteExecutor("invalid-runtime");

    await expect(executor.exec("pwd")).rejects.toThrow("invalid runtime response");
  });

  test("a failed lease renewal stops retrying and forces fresh authorization", async () => {
    vi.useFakeTimers();
    const executor = createRemoteExecutor("renew-failure");
    await executor.exec("initial");
    daemon.failRenew = true;

    await vi.advanceTimersByTimeAsync(100_000);
    const renewCalls = daemon.calls.filter((call) => call.path.endsWith("/renew"));
    expect(renewCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(300_000);
    expect(daemon.calls.filter((call) => call.path.endsWith("/renew"))).toHaveLength(1);
    const acquireCount = daemon.calls.filter(
      (call) => call.method === "POST" && call.path === "/v1/leases",
    ).length;
    await expect(executor.exec("after-failure")).resolves.toMatchObject({ code: 0 });
    expect(
      daemon.calls.filter((call) => call.method === "POST" && call.path === "/v1/leases"),
    ).toHaveLength(acquireCount + 1);
    vi.useRealTimers();
  });

  test("a malformed lease renewal also stops retrying", async () => {
    vi.useFakeTimers();
    const executor = createRemoteExecutor("renew-malformed");
    await executor.exec("initial");
    daemon.invalidRenewResponse = true;

    await vi.advanceTimersByTimeAsync(100_000);
    await vi.advanceTimersByTimeAsync(300_000);

    expect(daemon.calls.filter((call) => call.path.endsWith("/renew"))).toHaveLength(1);
    vi.useRealTimers();
  });

  test("a failed remote stop keeps the placement and lease fence", async () => {
    const executor = createRemoteExecutor("stop-failure");
    await executor.exec("pwd");
    daemon.refuseStop = 1;

    await stopIdleGondolinVms(0, Date.now() + 1);

    expect(daemon.runtime?.instanceId).toBe("stop-failure");
    expect(daemon.leases.size).toBe(1);
  });

  test("ships vault credential files as content, separate from workspace mounts", async () => {
    const credDir = mkdtempSync(join(tmpdir(), "remote-cred-"));
    const credFile = join(credDir, "gws.json");
    writeFileSync(credFile, '{"token":"secret"}');
    try {
      const executor = new GondolinExecutor({
        type: "gondolin",
        profile: "remote",
        instanceId: "remote-cred",
        workspacePath: "/host/workspace",
        mounts: [
          { source: "/host/workspace/C123", target: "/workspace/C123" },
          { source: credFile, target: "/root/.config/gws/credentials.json" },
        ],
      });

      await executor.exec("pwd");

      const ensure = daemon.calls.find((call) => call.path === "/v1/runtimes");
      // workspace mount translated; credential shipped as content, not a mount
      expect(ensure?.body?.mounts).toEqual([
        { source: "/srv/workspace/C123", target: "/workspace/C123" },
      ]);
      const credentialFiles = ensure?.body?.credentialFiles as Array<{
        target: string;
        contentBase64: string;
      }>;
      expect(credentialFiles).toHaveLength(1);
      expect(credentialFiles[0].target).toBe("/root/.config/gws/credentials.json");
      expect(Buffer.from(credentialFiles[0].contentBase64, "base64").toString()).toBe(
        '{"token":"secret"}',
      );
    } finally {
      rmSync(credDir, { recursive: true, force: true });
    }
  });

  test("sends vault env per command through the tunnel", async () => {
    const executor = createRemoteExecutor("remote-env", { GH_TOKEN: "secret" });

    await executor.exec("git fetch");

    expect(daemon.execs[0].env).toContain("GH_TOKEN=secret");
  });

  test("retries ensure once with a fresh lease after fencing", async () => {
    const executor = createRemoteExecutor("remote-fenced");
    await executor.exec("pwd");

    // another holder bumps the epoch: our cached lease is now stale
    daemon.epochs.set("remote-fenced", (daemon.epochs.get("remote-fenced") ?? 0) + 1);
    await disconnectAllGondolinRuntimes();

    const result = await executor.exec("pwd");
    expect(result.code).toBe(0);
    const acquisitions = daemon.calls.filter((call) => call.path === "/v1/leases");
    expect(acquisitions.length).toBeGreaterThanOrEqual(2);
  });

  test("recovers when the runtime disappears between commands", async () => {
    const executor = createRemoteExecutor("remote-crash");
    await executor.exec("pwd");
    const first = daemon.runtime?.sessionId;

    daemon.runtime = undefined; // worker host lost the runtime

    const result = await executor.exec("pwd");
    expect(result.code).toBe(0);
    expect(daemon.runtime?.sessionId).not.toBe(first);
  });

  test("stops the runtime and releases the lease on idle stop", async () => {
    const executor = createRemoteExecutor("remote-idle");
    await executor.exec("pwd");

    await stopIdleGondolinVms(0, Date.now() + 1);

    expect(daemon.runtime).toBeUndefined();
    expect(daemon.leases.size).toBe(0);
  });
});

describe("session frame codec", () => {
  test("reassembles frames split across chunks", () => {
    const json: object[] = [];
    const binary: Buffer[] = [];
    const parse = createSessionFrameParser({
      onJson: (message) => json.push(message),
      onBinary: (frame) => binary.push(frame),
      onClose: () => {},
    });

    const jsonPayload = Buffer.from(JSON.stringify({ type: "exec_response", id: 1 }));
    const frame = Buffer.alloc(5 + jsonPayload.length);
    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(jsonPayload.length, 1);
    jsonPayload.copy(frame, 5);
    const binaryPayload = Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), Buffer.from("abc")]);
    const binaryHeader = Buffer.alloc(5);
    binaryHeader.writeUInt8(1, 0);
    binaryHeader.writeUInt32BE(binaryPayload.length, 1);
    const binaryFrame = Buffer.concat([binaryHeader, binaryPayload]);
    const stream = Buffer.concat([frame, binaryFrame]);

    for (const byte of stream) parse(Buffer.from([byte]));

    expect(json).toEqual([{ type: "exec_response", id: 1 }]);
    expect(binary).toHaveLength(1);
    expect(binary[0].subarray(5).toString()).toBe("abc");
  });

  test("fails closed on oversized, unknown, and malformed frames", () => {
    for (const frame of [
      (() => {
        const header = Buffer.alloc(5);
        header.writeUInt8(0, 0);
        header.writeUInt32BE((8 << 20) + 1, 1);
        return header;
      })(),
      Buffer.from([2, 0, 0, 0, 0]),
      Buffer.concat([Buffer.from([0, 0, 0, 0, 1]), Buffer.from("{")]),
      Buffer.concat([Buffer.from([0, 0, 0, 0, 4]), Buffer.from("null")]),
      Buffer.concat([Buffer.from([0, 0, 0, 0, 2]), Buffer.from("{}")]),
      Buffer.from([1, 0, 0, 0, 0]),
      Buffer.from([1, 0, 0, 0, 5, 3, 0, 0, 0, 1]),
    ]) {
      const messages: Array<{ type: string; code?: string }> = [];
      const parse = createSessionFrameParser({
        onJson: (message) => messages.push(message),
        onBinary: () => {},
      });

      parse(frame);
      parse(Buffer.concat([Buffer.from([1, 0, 0, 0, 2]), Buffer.from("ok")]));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    }
  });

  test("rejects oversized outbound messages", () => {
    expect(() => encodeSessionMessage({ data: "x".repeat((8 << 20) + 1) })).toThrow(
      "encoded message exceeds",
    );
  });

  test("encodes client messages with a length prefix", () => {
    const encoded = encodeSessionMessage({ type: "exec", id: 1 });
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4);
    expect(JSON.parse(encoded.subarray(4).toString()).type).toBe("exec");
  });
});
