import { Type, type Static } from "@sinclair/typebox";
import { isRecord } from "../utils/file-guards.js";

/**
 * Single home for the wire shapes shared by mikan's local Gondolin client and
 * detached worker process.
 */

const GondolinMountSchema = Type.Object({
  source: Type.String(),
  target: Type.String(),
  /** Optional so worker processes from an older build still accept the config. */
  readOnly: Type.Optional(Type.Boolean()),
});

/**
 * Everything a worker process needs to host one Gondolin VM. Serialized as a
 * single JSON argv entry by the local TS worker client.
 */
export const GondolinWorkerConfigSchema = Type.Object({
  /** mikan session key the runtime belongs to. */
  instanceId: Type.String(),
  /** Resolved guest image asset directory. */
  image: Type.Optional(Type.String()),
  /** Optional image selector resolved inside the worker when no image path is supplied. */
  imageSelector: Type.Optional(Type.String()),
  mounts: Type.Array(GondolinMountSchema),
  cpus: Type.Optional(Type.Number()),
  memory: Type.Optional(Type.String()),
  /** Desired-runtime fingerprint recorded for adoption checks. */
  fingerprint: Type.String(),
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
 * read back by the TS inventory.
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
