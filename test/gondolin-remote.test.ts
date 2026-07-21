import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSessionFrameParser, encodeSessionMessage } from "../src/sandbox/gondolin-remote.js";
import { gondolinFleet } from "../src/sandbox/gondolin-fleet.js";
import { GondolinPlacementStore } from "../src/sandbox/gondolin-placement.js";
import {
  GondolinExecutor,
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

  request = async (
    method: string,
    path: string,
    body?: object,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const call = { method, path, body: body as Record<string, unknown>, headers };
    this.calls.push(call);
    if (method === "GET" && path === "/v1/health") {
      return { status: 200, json: { activeRuntimes: this.runtime ? 1 : 0 } };
    }
    if (method === "POST" && path === "/v1/leases") {
      const instanceId = call.body?.instanceId as string;
      const epoch = (this.epochs.get(instanceId) ?? 0) + 1;
      this.epochs.set(instanceId, epoch);
      const id = `lease-${instanceId}-${epoch}`;
      this.leases.set(id, { instanceId, epoch });
      return { status: 200, json: { id, epoch, instanceId } };
    }
    if (method === "POST" && path.endsWith("/renew")) {
      const id = path.split("/")[3];
      return this.leases.has(id) ? { status: 200, json: {} } : { status: 404, json: {} };
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
        json: { sessionId: this.runtime.sessionId, workerPid: 7000 + this.nextSession },
      };
    }
    if (method === "GET" && path.startsWith("/v1/runtimes/")) {
      const sessionId = path.split("/")[3];
      return this.runtime?.sessionId === sessionId
        ? { status: 200, json: {} }
        : { status: 404, json: {} };
    }
    if (method === "DELETE" && path.startsWith("/v1/runtimes/")) {
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
    gondolinFleet.configure();
    if (nodeVersion) Object.defineProperty(process.versions, "node", nodeVersion);
    vi.restoreAllMocks();
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
      // workspace mounts translate to the worker-side root; the directory-shaped
      // vault mount outside the shared workspace has no payload transport and is
      // dropped (needs shared storage)
      mounts: [{ source: "/srv/workspace/C123", target: "/workspace/C123" }],
    });
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
    const binaryFrame = Buffer.concat([Buffer.from([1, 0, 0, 0, 3]), Buffer.from("abc")]);
    const stream = Buffer.concat([frame, binaryFrame]);

    for (const byte of stream) parse(Buffer.from([byte]));

    expect(json).toEqual([{ type: "exec_response", id: 1 }]);
    expect(binary).toHaveLength(1);
    expect(binary[0].toString()).toBe("abc");
  });

  test("encodes client messages with a length prefix", () => {
    const encoded = encodeSessionMessage({ type: "exec", id: 1 });
    expect(encoded.readUInt32BE(0)).toBe(encoded.length - 4);
    expect(JSON.parse(encoded.subarray(4).toString()).type).toBe("exec");
  });
});
