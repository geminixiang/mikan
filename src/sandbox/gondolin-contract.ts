import { Type, type Static } from "@sinclair/typebox";
import { isRecord } from "../utils/file-guards.js";

/**
 * Single home for every wire shape that crosses the mikan ⇄ gondolin-worker
 * boundary. The Go daemon mirrors these shapes by hand
 * (worker/internal/runtime/supervisor.go, worker/internal/api/server.go,
 * worker/internal/lease/lease.go); the shared fixtures under
 * `worker/contract-fixtures/` pin both sides — the TS test
 * (test/gondolin-contract.test.ts) checks each fixture against the schemas
 * here, and the Go contract tests round-trip the same files through the Go
 * structs. Add a field on one side only and one of those tests fails.
 *
 * Secrets never travel through these shapes: vault env rides per-exec over
 * the session IPC socket, and credential files are shipped by content only
 * on the authenticated ensure request.
 */

const GondolinNetworkPolicySchema = Type.Object({
  allowedHosts: Type.Optional(Type.Array(Type.String())),
  allowedInternalHosts: Type.Optional(Type.Array(Type.String())),
  blockInternalRanges: Type.Optional(Type.Boolean()),
});

const GondolinMountSchema = Type.Object({
  source: Type.String(),
  target: Type.String(),
});

/**
 * Everything a worker process needs to host one Gondolin VM. Serialized as a
 * single JSON argv entry by both spawners (the local TS worker client and
 * the Go daemon's supervisor).
 */
export const GondolinWorkerConfigSchema = Type.Object({
  /** mikan session key the runtime belongs to. */
  instanceId: Type.String(),
  /** Resolved guest image asset directory. */
  image: Type.Optional(Type.String()),
  /** Image selector resolved inside the worker (remote workers, where the
   * spawning host has no image store). Ignored when `image` is set. */
  imageSelector: Type.Optional(Type.String()),
  mounts: Type.Array(GondolinMountSchema),
  cpus: Type.Optional(Type.Number()),
  memory: Type.Optional(Type.String()),
  /** Desired-runtime fingerprint recorded for adoption checks. */
  fingerprint: Type.String(),
  network: Type.Optional(GondolinNetworkPolicySchema),
  /** Runtime inventory directory (shared with the spawning mikan). */
  inventoryDir: Type.String(),
  /** Self-stop when the mikan heartbeat file is older than this. 0 disables. */
  heartbeatStaleMs: Type.Number(),
});

export type GondolinWorkerConfig = Static<typeof GondolinWorkerConfigSchema>;

/** First stdout line of a worker, consumed by both spawners. */
export const GondolinWorkerHandshakeSchema = Type.Object({
  ready: Type.Boolean(),
  error: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  socketPath: Type.Optional(Type.String()),
  workerPid: Type.Optional(Type.Number()),
  runnerPid: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});

export type GondolinWorkerHandshake = Static<typeof GondolinWorkerHandshakeSchema>;

/**
 * One `<sessionId>.json` inventory record, written by the worker process and
 * read back by the TS inventory and the Go daemon's rediscovery.
 */
export const GondolinRuntimeRecordSchema = Type.Object({
  /** Gondolin session id (`vm.id`); also names the record file. */
  sessionId: Type.String(),
  /** mikan session key (vault key) the runtime was created for. */
  instanceId: Type.String(),
  /** Process that owns the runtime (the worker process). */
  ownerPid: Type.Number(),
  /** Host pid of the active VM runner process (QEMU/krun), if started. */
  runnerPid: Type.Union([Type.Number(), Type.Null()]),
  createdAt: Type.String(),
  /** Session IPC socket for adopting the runtime from a new mikan process. */
  socketPath: Type.Optional(Type.String()),
  /** Desired-runtime fingerprint the VM was created from. */
  fingerprint: Type.Optional(Type.String()),
});

export type GondolinRuntimeRecord = Static<typeof GondolinRuntimeRecordSchema>;

export function isGondolinRuntimeRecord(value: unknown): value is GondolinRuntimeRecord {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    typeof value.instanceId === "string" &&
    typeof value.ownerPid === "number" &&
    (value.runnerPid === null || typeof value.runnerPid === "number") &&
    typeof value.createdAt === "string" &&
    (value.socketPath === undefined || typeof value.socketPath === "string") &&
    (value.fingerprint === undefined || typeof value.fingerprint === "string")
  );
}

/** A vault credential shipped by content on the ensure request (never a shared-fs mount). */
const GondolinCredentialFileSchema = Type.Object({
  target: Type.String(),
  contentBase64: Type.String(),
});

export type GondolinCredentialFile = Static<typeof GondolinCredentialFileSchema>;

/** POST /v1/runtimes body sent to the remote worker daemon. */
export const GondolinEnsureRuntimeRequestSchema = Type.Object({
  instanceId: Type.String(),
  imageSelector: Type.String(),
  mounts: Type.Array(GondolinMountSchema),
  credentialFiles: Type.Array(GondolinCredentialFileSchema),
  /** Fractional cgroup CPU limit as a string; "" when unset. */
  cpus: Type.String(),
  memory: Type.String(),
  fingerprint: Type.String(),
  network: Type.Optional(GondolinNetworkPolicySchema),
  /** Runtime watchdog: half the lease TTL, so a daemon crash cannot leave an unfenced VM alive. */
  heartbeatStaleMs: Type.Optional(Type.Number()),
});

export type GondolinEnsureRuntimeRequest = Static<typeof GondolinEnsureRuntimeRequestSchema>;

/**
 * One runtime as reported by the daemon (ensure response, GET, and the
 * elements of the list response). The daemon's socketPath never crosses the
 * wire — sessions reach the runtime through the tunnel, not the socket.
 */
export const GondolinRemoteRuntimeSchema = Type.Object({
  sessionId: Type.String(),
  instanceId: Type.String(),
  fingerprint: Type.String(),
  workerPid: Type.Number(),
  runnerPid: Type.Number(),
  epoch: Type.Number(),
  adopted: Type.Boolean(),
});

export type GondolinRemoteRuntime = Static<typeof GondolinRemoteRuntimeSchema>;

/** POST /v1/leases response: a fenced, epoch-monotonic per-instance lease. */
export const GondolinLeaseGrantSchema = Type.Object({
  id: Type.String(),
  instanceId: Type.String(),
  epoch: Type.Number(),
  /** RFC 3339 timestamp (Go time.Time marshalling). */
  expiresAt: Type.String(),
});

// ── session tunnel framing ────────────────────────────────────────────────────
// The session protocol itself is TS⇄TS (worker session server ⇄ client); the
// Go daemon splices it byte-for-byte through the upgraded tunnel. The framing
// still lives here because it is part of the boundary a transport must carry.

/** Structural shape of the JSON messages on the session protocol. */
export interface SessionFrameCallbacks {
  onJson: (message: {
    type: string;
    id?: number;
    exit_code?: number | null;
    code?: string;
    message?: string;
  }) => void;
  onBinary: (frame: Buffer) => void;
}

const MAX_SESSION_FRAME_BYTES = 8 << 20;

/** Parses the daemon-to-client session framing: u8 type + u32be length + payload. */
export function createSessionFrameParser(
  callbacks: SessionFrameCallbacks,
): (chunk: Buffer) => void {
  let buffer = Buffer.alloc(0);
  let failed = false;
  const fail = (message: string): void => {
    failed = true;
    buffer = Buffer.alloc(0);
    callbacks.onJson({ type: "error", code: "PROTOCOL_ERROR", message });
  };
  return (chunk: Buffer) => {
    if (failed) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5) {
      const type = buffer.readUInt8(0);
      const length = buffer.readUInt32BE(1);
      if (length > MAX_SESSION_FRAME_BYTES) {
        fail(`session frame exceeds ${MAX_SESSION_FRAME_BYTES} bytes`);
        return;
      }
      if (buffer.length < 5 + length) return;
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);
      if (type === 1) {
        if (payload.length < 5) {
          fail("truncated session binary frame");
          return;
        }
        const streamTag = payload.readUInt8(0);
        if (streamTag !== 1 && streamTag !== 2) {
          fail(`unknown session output stream ${streamTag}`);
          return;
        }
        callbacks.onBinary(Buffer.from(payload));
        continue;
      }
      if (type !== 0) {
        fail(`unknown session frame type ${type}`);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(payload.toString("utf8"));
        if (!isRecord(parsed) || typeof parsed.type !== "string") {
          fail("invalid session JSON frame");
          return;
        }
        callbacks.onJson(parsed as Parameters<SessionFrameCallbacks["onJson"]>[0]);
      } catch {
        fail("malformed session JSON frame");
        return;
      }
    }
  };
}

const MAX_ENCODED_MESSAGE_BYTES = 8 << 20;

/** Encodes a client-to-daemon session message: u32be length + JSON. */
export function encodeSessionMessage(message: object): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_ENCODED_MESSAGE_BYTES) {
    throw new Error(`encoded message exceeds ${MAX_ENCODED_MESSAGE_BYTES} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}
