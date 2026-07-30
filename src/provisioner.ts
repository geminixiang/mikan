import { execFile } from "node:child_process";
import { sanitizeIdentitySegment } from "./sandbox/identity.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import * as log from "./log.js";
import { readEnv } from "./env-manifest.js";
import { reportUserFacingError } from "./observability/sentry.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

type ContainerStatus = "running" | "stopped" | "missing";

function isDockerNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const stderr = (err as { stderr?: unknown }).stderr;
  const message = (err as { message?: unknown }).message;
  const haystack = `${typeof stderr === "string" ? stderr : ""}\n${
    typeof message === "string" ? message : ""
  }`.toLowerCase();
  return (
    haystack.includes("no such network") ||
    haystack.includes("no such container") ||
    haystack.includes("no such object") ||
    haystack.includes("network not found") ||
    /network [^\n]+ not found/.test(haystack) ||
    /error: no such [^\n]+/.test(haystack)
  );
}

interface ContainerState {
  status: ContainerStatus;
  lastUsed: number;
  containerName: string;
}

export type {
  ContainerMount,
  DockerContainerManagerOptions,
  ProvisionOptions,
  ResourceLimits,
  SandboxLimitStatus,
} from "./types.js";
import type {
  ContainerMount,
  DockerContainerManagerOptions,
  ProvisionOptions,
  ResourceLimits,
  SandboxLimitStatus,
} from "./types.js";

/**
 * Rewrites one docker bind spec (`src:dst[:ro]`) from the legacy raw-id
 * layout to the office-key layout. Returns the spec unchanged when nothing in
 * it needs translation; a container whose binds are all unchanged is already
 * on the current layout.
 */
export type ContainerBindTranslator = (bindSpec: string) => string;

/** Parse `src:dst[:ro]` back into a ContainerMount for signature computation. */
function bindSpecToMount(bindSpec: string): ContainerMount {
  const readOnly = bindSpec.endsWith(":ro");
  const spec = readOnly ? bindSpec.slice(0, -3) : bindSpec;
  const separator = spec.indexOf(":");
  return {
    source: spec.slice(0, separator),
    target: spec.slice(separator + 1),
    ...(readOnly ? { readOnly: true as const } : {}),
  };
}

export class DockerContainerManager {
  private state = new Map<string, ContainerState>();
  private inflight = new Map<string, Promise<string>>();
  /** Active layout migration; unset means no translation ever applies. */
  private bindTranslator?: ContainerBindTranslator;
  private layoutMigrations = new Map<string, Promise<void>>();
  private static readonly MANAGED_LABEL = "mikan.managed=true";
  private static readonly IMAGE_MODE_LABEL = "mikan.sandbox=image";
  private static readonly VAULT_ID_LABEL_KEY = "mikan.vault-id";
  private static readonly CONVERSATION_ID_LABEL_KEY = "mikan.conversation-id";
  private static readonly MOUNT_SIGNATURE_LABEL_KEY = "mikan.mount-signature";
  private static readonly MIGRATE_IMAGE_PREFIX = "mikan-migrate";
  private static readonly MIGRATE_BINDS_LABEL_KEY = "mikan.migrate-binds";

  private readonly limits?: ResourceLimits;
  private readonly boostLimits?: ResourceLimits;
  private readonly boostedKeys = new Set<string>();
  private readonly overrideLimits = new Map<string, ResourceLimits>();
  private readonly execFileImpl: ExecFileAsync;

  constructor(
    private readonly image: string,
    options: DockerContainerManagerOptions = {},
  ) {
    this.limits = options.limits;
    this.boostLimits = options.boostLimits;
    this.execFileImpl = options.execFileImpl ?? execFileAsync;
  }

  static sanitizeSegment(value: string): string {
    return sanitizeIdentitySegment(value);
  }

  static containerName(containerKey: string): string {
    return `mikan-sandbox-${containerKey}`;
  }

  static networkName(containerKey: string): string {
    return `mikan-sandbox-net-${containerKey}`;
  }

  async provision(containerKey: string, options: ProvisionOptions = {}): Promise<string> {
    const existing = this.inflight.get(containerKey);
    if (existing) return existing;

    const pending = this.provisionInner(containerKey, options).finally(() => {
      this.inflight.delete(containerKey);
    });
    this.inflight.set(containerKey, pending);
    return pending;
  }

  private async provisionInner(containerKey: string, options: ProvisionOptions): Promise<string> {
    const containerName =
      options.containerName ?? DockerContainerManager.containerName(containerKey);
    const mounts = options.mounts ?? [];
    // A container still on the pre-office layout must move its writable layer
    // to the new mounts before the drift check below would recreate it from
    // the base image and discard everything installed inside.
    await this.migrateContainerLayout(containerName);
    const status = await this.inspectStatus(containerName);

    try {
      if (
        status !== "missing" &&
        (await this.hasRuntimeDrift(containerKey, containerName, mounts))
      ) {
        log.logInfo(`Container ${containerName} configuration changed; recreating container`);
        if (readEnv("SKIP_CONTAINER_PRESERVATION") === "1") {
          await this.execFileImpl("docker", ["rm", "-f", containerName]);
          await this.removeMigrateSnapshot(containerName);
          await this.runContainer(containerKey, containerName, mounts, options);
        } else {
          await this.recreateContainerPreservingContents(containerKey, containerName, mounts);
        }
        log.logInfo(`Container ${containerName} recreated`);
      } else if (status === "running") {
        log.logInfo(`Container ${containerName} already running`);
      } else if (status === "stopped") {
        await this.execFileImpl("docker", ["start", containerName]);
        log.logInfo(`Container ${containerName} started`);
      } else {
        await this.runContainer(containerKey, containerName, mounts, options);
        log.logInfo(`Container ${containerName} created`);
      }
    } catch (err) {
      this.state.delete(containerKey);
      throw err;
    }

    this.setState(containerKey, "running", containerName);
    await this.applyResourceLimits(containerKey, containerName);
    return containerName;
  }

  async boost(containerKey: string): Promise<SandboxLimitStatus> {
    if (!this.boostLimits?.cpus && !this.boostLimits?.memory) {
      return this.getLimitStatus(containerKey);
    }

    this.overrideLimits.delete(containerKey);
    this.boostedKeys.add(containerKey);
    const state = this.state.get(containerKey);
    if (state?.status === "running") {
      await this.applyResourceLimits(containerKey, state.containerName);
    }
    return this.getLimitStatus(containerKey);
  }

  async setLimits(containerKey: string, limits: ResourceLimits): Promise<SandboxLimitStatus> {
    this.boostedKeys.delete(containerKey);
    this.overrideLimits.set(containerKey, { ...this.limits, ...limits });
    const state = this.state.get(containerKey);
    if (state?.status === "running") {
      await this.applyResourceLimits(containerKey, state.containerName);
    }
    return this.getLimitStatus(containerKey);
  }

  getLimitStatus(containerKey: string): SandboxLimitStatus {
    const boosted = this.boostedKeys.has(containerKey);
    return { limits: this.effectiveLimits(containerKey), boosted };
  }

  getDefaultLimits(): ResourceLimits | undefined {
    return this.limits;
  }

  getBoostLimits(): ResourceLimits | undefined {
    return this.boostLimits;
  }

  async stop(containerKey: string): Promise<void> {
    const containerName = this.getContainerName(containerKey);
    try {
      await this.execFileImpl("docker", ["stop", containerName]);
      this.setState(containerKey, "stopped", containerName);
      this.boostedKeys.delete(containerKey);
      this.overrideLimits.delete(containerKey);
      log.logInfo(`Container ${containerName} stopped (idle)`);
    } catch (err) {
      log.logWarning(
        `Failed to stop container ${containerName}`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async remove(containerKey: string): Promise<void> {
    const containerName = this.getContainerName(containerKey);
    const networkName = DockerContainerManager.networkName(containerKey);

    await this.forceRemoveContainer(
      containerName,
      `Container ${containerName} removed`,
      `Failed to remove container ${containerName}`,
    );

    try {
      await this.execFileImpl("docker", ["network", "rm", networkName]);
      log.logInfo(`Network ${networkName} removed`);
    } catch (err) {
      log.logWarning(
        `Failed to remove network ${networkName}`,
        err instanceof Error ? err.message : String(err),
      );
    }

    await this.removeMigrateSnapshot(containerName);

    this.state.delete(containerKey);
    this.boostedKeys.delete(containerKey);
    this.overrideLimits.delete(containerKey);
  }

  async stopIdle(maxIdleMs: number): Promise<void> {
    const now = Date.now();
    const toStop: string[] = [];
    for (const [containerKey, containerState] of this.state) {
      if (containerState.status === "running" && now - containerState.lastUsed > maxIdleMs) {
        toStop.push(containerKey);
      }
    }
    await Promise.all(toStop.map((containerKey) => this.stop(containerKey)));
  }

  /**
   * Force-remove every managed container belonging to the given conversation
   * ids. The office layout migration renames the host directories a
   * container's workspace mount points at, so a surviving container would keep
   * writing through stale mounts while the runtime works in the new location.
   */
  async removeContainersForConversations(conversationIds: ReadonlySet<string>): Promise<void> {
    if (conversationIds.size === 0) return;
    const names = await this.listContainerNamesByLabel();
    await Promise.all(
      names.map(async (containerName) => {
        const details = await this.inspectContainerDetails(containerName);
        if (!details?.conversationId || !conversationIds.has(details.conversationId)) return;
        await this.forceRemoveContainer(
          containerName,
          `Removed container ${containerName} after office migration`,
          `Failed to remove container ${containerName} after office migration`,
        );
      }),
    );
  }

  /**
   * Arm the office-layout container migration. Containers whose binds still
   * reference legacy raw-id paths are moved to the office-key layout without
   * losing their writable layer: commit → remove → create with translated
   * binds, preserving everything installed inside. Idempotent per container
   * and resumable — the pre-removal binds ride on the snapshot image label,
   * so a crash between commit and create resumes from the snapshot.
   */
  armContainerLayoutMigration(translator: ContainerBindTranslator): void {
    this.bindTranslator = translator;
  }

  /**
   * Sweep every managed container through the layout migration, serially and
   * with a small gap, so the one-time cost never lands on the boot path or on
   * a message. Safe to fire-and-forget; each unit is idempotent.
   */
  async sweepContainerLayoutMigration(delayMs = 2000): Promise<void> {
    if (!this.bindTranslator) return;
    let names: string[];
    try {
      // Include snapshot names: a crash between commit and create leaves a
      // snapshot with no container, which must resume before the GC below
      // could mistake it for an orphan.
      const containers = await this.listContainerNamesByLabel();
      const snapshots = await this.listMigrateSnapshotContainerNames();
      names = Array.from(new Set([...containers, ...snapshots]));
    } catch (err) {
      log.logWarning("Container layout sweep could not list containers", String(err));
      return;
    }
    for (const containerName of names) {
      try {
        await this.migrateContainerLayout(containerName);
      } catch (err) {
        log.logWarning(
          `Container layout migration failed for ${containerName}; leaving it in place`,
          err instanceof Error ? err.message : String(err),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    // Snapshot images whose container has since been recreated from the base
    // image are no longer referenced; reclaim them.
    await this.removeDanglingMigrateImages();
  }

  /** Move one container to the office-key layout; no-op when already there. */
  private migrateContainerLayout(containerName: string): Promise<void> {
    const translator = this.bindTranslator;
    if (!translator) return Promise.resolve();
    const existing = this.layoutMigrations.get(containerName);
    if (existing) return existing;
    const pending = this.migrateContainerLayoutInner(containerName, translator).finally(() => {
      this.layoutMigrations.delete(containerName);
    });
    this.layoutMigrations.set(containerName, pending);
    return pending;
  }

  private async migrateContainerLayoutInner(
    containerName: string,
    translator: ContainerBindTranslator,
  ): Promise<void> {
    const snapshotImage = `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`;

    let originalBinds: string[];
    const status = await this.inspectStatus(containerName);
    if (status === "missing") {
      // Resume path: a previous run committed and removed the container but
      // died before creating the replacement. The snapshot carries the
      // pre-removal binds on its label.
      const labeled = await this.readMigrateImageBinds(snapshotImage);
      if (labeled === undefined) return;
      originalBinds = labeled;
    } else {
      originalBinds = await this.inspectBindMounts(containerName);
      const translated = originalBinds.map(translator);
      if (this.sameBinds(translated.toSorted(), originalBinds.slice().toSorted())) {
        return; // already on the office layout
      }
      log.logInfo(`Migrating container ${containerName} to the office layout`);
      await this.execFileImpl("docker", [
        "commit",
        "-c",
        `LABEL ${DockerContainerManager.MIGRATE_BINDS_LABEL_KEY}=${JSON.stringify(JSON.stringify(originalBinds))}`,
        containerName,
        snapshotImage,
      ]);
      await this.execFileImpl("docker", ["rm", "-f", containerName]);
    }

    await this.createContainerFromSnapshot(containerName, originalBinds.map(translator));
    log.logInfo(`Container ${containerName} migrated to the office layout`);
  }

  /**
   * Create `containerName` from its layout snapshot with `bindSpecs`,
   * restoring the managed labels and recomputing the mount signature.
   * `create`, not `run`: idle containers stay stopped exactly as they were;
   * callers that need the container running start it themselves.
   */
  private async createContainerFromSnapshot(
    containerName: string,
    bindSpecs: string[],
    knownContainerKey?: string,
  ): Promise<void> {
    const snapshotImage = `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`;
    // The sweep has only the container name and derives the key; the drift
    // path knows the real key (container names can be caller-supplied).
    const containerKey =
      knownContainerKey ?? this.containerKeyFromContainerName(containerName) ?? containerName;
    const networkName = await this.ensureNetwork(containerKey);
    const conversationId = await this.readImageLabel(
      snapshotImage,
      DockerContainerManager.CONVERSATION_ID_LABEL_KEY,
    );
    const labels = [
      "--label",
      DockerContainerManager.MANAGED_LABEL,
      "--label",
      DockerContainerManager.IMAGE_MODE_LABEL,
      "--label",
      `${DockerContainerManager.VAULT_ID_LABEL_KEY}=${containerKey}`,
    ];
    if (conversationId) {
      labels.push(
        "--label",
        `${DockerContainerManager.CONVERSATION_ID_LABEL_KEY}=${conversationId}`,
      );
    }
    labels.push(
      "--label",
      `${DockerContainerManager.MOUNT_SIGNATURE_LABEL_KEY}=${this.mountSignature(
        bindSpecs.map(bindSpecToMount),
      )}`,
    );
    await this.execFileImpl("docker", [
      "create",
      "--name",
      containerName,
      "--network",
      networkName,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
      ...labels,
      ...this.resourceLimitArgs(this.effectiveLimits(containerKey)),
      ...bindSpecs.flatMap((bind) => ["-v", bind]),
      snapshotImage,
      "sleep",
      "infinity",
    ]);
  }

  /**
   * Recreate a drifted container with the desired mounts while keeping its
   * writable layer: commit — the new binds ride the snapshot label, so a
   * crash at any point resumes through the layout-migration path — then
   * remove, create from the snapshot, and start. Committing replaces any
   * older snapshot tag for this container; the untagged predecessor is
   * removed once the new container is up.
   */
  private async recreateContainerPreservingContents(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<void> {
    const snapshotImage = `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`;
    const bindSpecs = mounts.map((mount) => this.toBindSpec(mount));
    const previousImageId = await this.readImageId(snapshotImage);
    await this.execFileImpl("docker", [
      "commit",
      "-c",
      `LABEL ${DockerContainerManager.MIGRATE_BINDS_LABEL_KEY}=${JSON.stringify(JSON.stringify(bindSpecs))}`,
      containerName,
      snapshotImage,
    ]);
    await this.execFileImpl("docker", ["rm", "-f", containerName]);
    await this.createContainerFromSnapshot(containerName, bindSpecs, containerKey);
    await this.execFileImpl("docker", ["start", containerName]);
    const currentImageId = await this.readImageId(snapshotImage);
    if (previousImageId && previousImageId !== currentImageId) {
      try {
        await this.execFileImpl("docker", ["rmi", previousImageId]);
      } catch (err) {
        log.logWarning(
          `Could not remove superseded snapshot image ${previousImageId}`,
          String(err),
        );
      }
    }
  }

  /** Resolved image id for a reference, or undefined when it does not exist. */
  private async readImageId(image: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.execFileImpl("docker", ["inspect", "-f", "{{.Id}}", image]);
      const id = stdout.trim();
      return id.length > 0 ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /** Binds recorded on a snapshot image, or undefined when no snapshot exists. */
  private async readMigrateImageBinds(snapshotImage: string): Promise<string[] | undefined> {
    const raw = await this.readImageLabel(
      snapshotImage,
      DockerContainerManager.MIGRATE_BINDS_LABEL_KEY,
    );
    if (raw === undefined) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.some((bind) => typeof bind !== "string")) {
      throw new Error(`Snapshot image ${snapshotImage} carries malformed migrate binds`);
    }
    return parsed;
  }

  private async readImageLabel(image: string, key: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        `{{index .Config.Labels "${key}"}}`,
        image,
      ]);
      return this.normalizeDockerValue(stdout.trim());
    } catch {
      return undefined;
    }
  }

  /**
   * Delete a container's layout snapshot after an intentional removal, so a
   * missing container plus a surviving snapshot can only mean a crash in the
   * middle of the layout migration (the resume discriminator).
   */
  private async removeMigrateSnapshot(containerName: string): Promise<void> {
    try {
      await this.execFileImpl("docker", [
        "rmi",
        `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`,
      ]);
    } catch {
      // No snapshot for this container — the common case.
    }
  }

  private async listMigrateSnapshotContainerNames(): Promise<string[]> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "images",
        DockerContainerManager.MIGRATE_IMAGE_PREFIX,
        "--format",
        "{{.Tag}}",
      ]);
      return this.parseNameLines(stdout);
    } catch {
      return [];
    }
  }

  private async removeDanglingMigrateImages(): Promise<void> {
    let stdout: string;
    try {
      ({ stdout } = await this.execFileImpl("docker", [
        "images",
        `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]));
    } catch {
      return;
    }
    for (const image of this.parseNameLines(stdout)) {
      const containerName = image.slice(DockerContainerManager.MIGRATE_IMAGE_PREFIX.length + 1);
      const status = await this.inspectStatus(containerName);
      if (status !== "missing") {
        // Still referenced (until the container's next natural recreation
        // from the base image); keep the snapshot.
        const { stdout: imageRef } = await this.execFileImpl("docker", [
          "inspect",
          "-f",
          "{{.Config.Image}}",
          containerName,
        ]);
        if (imageRef.trim() === image) continue;
      }
      try {
        await this.execFileImpl("docker", ["rmi", image]);
        log.logInfo(`Removed layout-migration snapshot image ${image}`);
      } catch (err) {
        log.logWarning(`Could not remove snapshot image ${image}`, String(err));
      }
    }
  }

  async reconcile(): Promise<void> {
    const discovered = new Set<string>();
    const labeledNames = await this.listContainerNamesByLabel();
    for (const name of labeledNames) discovered.add(name);
    const legacyNames = await this.listContainerNamesByPrefix();
    for (const name of legacyNames) discovered.add(name);

    this.state.clear();

    const inspected = await Promise.all(
      Array.from(discovered).map(async (containerName) => ({
        containerName,
        details: await this.inspectContainerDetails(containerName),
      })),
    );

    const legacyRemovals: Promise<void>[] = [];
    for (const { containerName, details } of inspected) {
      if (!details) continue;

      if (!details.conversationId) {
        legacyRemovals.push(this.removeLegacyContainer(containerName));
        continue;
      }

      const containerKey = this.containerKeyFromContainerName(containerName);
      if (!containerKey) {
        log.logWarning(`Skipping unmanaged-style container without container key`, containerName);
        continue;
      }

      const status: ContainerStatus = details.running ? "running" : "stopped";
      const lastUsed = details.startedAtMs ?? Date.now();
      this.state.set(containerKey, { status, lastUsed, containerName });
    }
    await Promise.all(legacyRemovals);

    const running = Array.from(this.state.values()).filter((s) => s.status === "running").length;
    const stopped = this.state.size - running;
    log.logInfo(
      `Reconciled ${this.state.size} managed containers (running=${running}, stopped=${stopped})`,
    );
  }

  private setState(containerKey: string, status: ContainerStatus, containerName: string): void {
    this.state.set(containerKey, { status, lastUsed: Date.now(), containerName });
  }

  private getContainerName(containerKey: string): string {
    return (
      this.state.get(containerKey)?.containerName ??
      DockerContainerManager.containerName(containerKey)
    );
  }

  private mountArgs(mounts: ContainerMount[]): string[] {
    return mounts.flatMap((mount) => ["-v", this.toBindSpec(mount)]);
  }

  private toBindSpec(mount: ContainerMount): string {
    // The `:ro` suffix is part of the bind spec, so it also flows into
    // expectedBinds/mountSignature — flipping a mount's writability is drift
    // and recreates the container rather than leaving a stale writable bind.
    return `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`;
  }

  private async runContainer(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
    options: ProvisionOptions,
  ): Promise<void> {
    const networkName = await this.ensureNetwork(containerKey);
    log.logInfo(`Creating container ${containerName} from image ${this.image}`);
    const labels = [
      "--label",
      DockerContainerManager.MANAGED_LABEL,
      "--label",
      DockerContainerManager.IMAGE_MODE_LABEL,
      "--label",
      `${DockerContainerManager.VAULT_ID_LABEL_KEY}=${containerKey}`,
    ];
    if (options.conversationId) {
      labels.push(
        "--label",
        `${DockerContainerManager.CONVERSATION_ID_LABEL_KEY}=${options.conversationId}`,
      );
    }
    if (mounts.length > 0) {
      labels.push(
        "--label",
        `${DockerContainerManager.MOUNT_SIGNATURE_LABEL_KEY}=${this.mountSignature(mounts)}`,
      );
    }
    await this.execFileImpl("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      networkName,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "1024",
      ...labels,
      ...this.resourceLimitArgs(this.effectiveLimits(containerKey)),
      ...this.mountArgs(mounts),
      this.image,
      "sleep",
      "infinity",
    ]);
  }

  private effectiveLimits(containerKey: string): ResourceLimits | undefined {
    const override = this.overrideLimits.get(containerKey);
    if (override) return override;
    if (!this.boostedKeys.has(containerKey)) return this.limits;
    return { ...this.limits, ...this.boostLimits };
  }

  private resourceLimitArgs(limits: ResourceLimits | undefined): string[] {
    const args: string[] = [];
    if (limits?.cpus) args.push("--cpus", limits.cpus);
    if (limits?.memory) {
      args.push("--memory", limits.memory);
      // Keep Docker's no-extra-swap semantics explicit. Docker requires
      // memory-swap to be updated together when raising an existing memory
      // limit above the current swap limit.
      args.push("--memory-swap", limits.memory);
    }
    return args;
  }

  private async applyResourceLimits(containerKey: string, containerName: string): Promise<void> {
    const limitArgs = this.resourceLimitArgs(this.effectiveLimits(containerKey));
    if (limitArgs.length === 0) return;
    const args = ["update", ...limitArgs, containerName];
    try {
      await this.execFileImpl("docker", args);
    } catch (err) {
      log.logWarning(
        `Failed to apply resource limits to container ${containerName}`,
        err instanceof Error ? err.message : String(err),
      );
      reportUserFacingError(err, {
        domain: "sandbox",
        surface: "sandbox_provision",
        operation: "apply_resource_limits",
        severity: "warning",
        context: {
          sandboxType: "image",
          containerKey,
          containerName,
          limitArgCount: limitArgs.length,
          fatal: false,
        },
      });
    }
  }

  private async hasRuntimeDrift(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<boolean> {
    if (await this.hasBindMountDrift(containerName, mounts)) {
      return true;
    }
    if (await this.hasMountSignatureDrift(containerName, mounts)) {
      return true;
    }
    return this.hasNetworkModeDrift(containerKey, containerName);
  }

  private async hasBindMountDrift(
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<boolean> {
    const expected = this.expectedBinds(mounts);
    const actual = await this.inspectBindMounts(containerName);
    return !this.sameBinds(expected, actual);
  }

  private expectedBinds(mounts: ContainerMount[]): string[] {
    return mounts
      .map((mount) => this.toBindSpec(mount))
      .slice()
      .toSorted();
  }

  private sameBinds(expected: string[], actual: string[]): boolean {
    if (expected.length !== actual.length) {
      return false;
    }

    return expected.every((bind, index) => bind === actual[index]);
  }

  private async hasMountSignatureDrift(
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<boolean> {
    if (mounts.length === 0) return false;
    const expected = this.mountSignature(mounts);
    const { stdout } = await this.execFileImpl("docker", [
      "inspect",
      "-f",
      `{{index .Config.Labels "${DockerContainerManager.MOUNT_SIGNATURE_LABEL_KEY}"}}`,
      containerName,
    ]);
    const actual = this.normalizeDockerValue(stdout.trim());
    return actual !== expected;
  }

  private mountSignature(mounts: ContainerMount[]): string {
    const payload = mounts
      .map((mount) => ({
        source: mount.source,
        target: mount.target,
        fingerprint: this.mountSourceFingerprint(mount.source),
      }))
      .toSorted((left, right) =>
        `${left.target}\0${left.source}`.localeCompare(`${right.target}\0${right.source}`),
      );
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  }

  private mountSourceFingerprint(source: string): string {
    try {
      const stat = statSync(source);
      if (stat.isFile()) {
        // Files are atomically replaced (rename), which leaves the container
        // holding a stale inode — content changes must recreate the mount.
        return createHash("sha256").update(readFileSync(source)).digest("hex");
      }
      // Directories: a bind mount follows changes inside the directory live,
      // so only replacing the directory itself makes the mount stale.
      // Size/mtime churn from ordinary activity — event files coming and
      // going, children being created — must not read as drift. Identity is
      // dev:ino plus birth time, because ext4 recycles inode numbers
      // immediately and a same-path replacement can reuse the old one.
      return `${stat.isDirectory() ? "dir" : "other"}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    } catch {
      return "missing";
    }
  }

  private async inspectBindMounts(containerName: string): Promise<string[]> {
    const { stdout } = await this.execFileImpl("docker", [
      "inspect",
      "-f",
      "{{json .HostConfig.Binds}}",
      containerName,
    ]);
    const payload = stdout.trim();
    const parsed = JSON.parse(payload.length > 0 ? payload : "null") as unknown;

    if (parsed === null) {
      return [];
    }

    if (!Array.isArray(parsed) || parsed.some((bind) => typeof bind !== "string")) {
      throw new Error(`Unexpected docker bind mount payload for container "${containerName}"`);
    }

    return [...parsed].toSorted();
  }

  private async hasNetworkModeDrift(containerKey: string, containerName: string): Promise<boolean> {
    const expected = DockerContainerManager.networkName(containerKey);
    const { stdout } = await this.execFileImpl("docker", [
      "inspect",
      "-f",
      "{{.HostConfig.NetworkMode}}",
      containerName,
    ]);
    return stdout.trim() !== expected;
  }

  private async ensureNetwork(containerKey: string): Promise<string> {
    const networkName = DockerContainerManager.networkName(containerKey);
    try {
      await this.execFileImpl("docker", ["network", "inspect", networkName]);
      return networkName;
    } catch (err) {
      if (!isDockerNotFoundError(err)) throw err;
    }
    await this.execFileImpl("docker", [
      "network",
      "create",
      "--driver",
      "bridge",
      "--label",
      DockerContainerManager.MANAGED_LABEL,
      "--label",
      DockerContainerManager.IMAGE_MODE_LABEL,
      "--label",
      `${DockerContainerManager.VAULT_ID_LABEL_KEY}=${containerKey}`,
      networkName,
    ]);
    return networkName;
  }

  private async inspectStatus(containerName: string): Promise<ContainerStatus> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        "{{.State.Running}}",
        containerName,
      ]);
      return stdout.trim() === "true" ? "running" : "stopped";
    } catch (err) {
      if (isDockerNotFoundError(err)) return "missing";
      throw err;
    }
  }

  private async listContainerNamesByLabel(): Promise<string[]> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "ps",
        "-a",
        "--filter",
        `label=${DockerContainerManager.MANAGED_LABEL}`,
        "--filter",
        `label=${DockerContainerManager.IMAGE_MODE_LABEL}`,
        "--format",
        "{{.Names}}",
      ]);
      return this.parseNameLines(stdout);
    } catch (err) {
      log.logWarning(
        "Failed to list labeled managed containers",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private async listContainerNamesByPrefix(): Promise<string[]> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "ps",
        "-a",
        "--filter",
        `name=${DockerContainerManager.containerName("")}`,
        "--format",
        "{{.Names}}",
      ]);
      return this.parseNameLines(stdout);
    } catch (err) {
      log.logWarning(
        "Failed to list legacy managed containers",
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  }

  private parseNameLines(stdout: string): string[] {
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async inspectContainerDetails(
    containerName: string,
  ): Promise<
    | { running: boolean; startedAtMs?: number; vaultId?: string; conversationId?: string }
    | undefined
  > {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        `{{.State.Running}}\t{{.State.StartedAt}}\t{{index .Config.Labels "${DockerContainerManager.VAULT_ID_LABEL_KEY}"}}\t{{index .Config.Labels "${DockerContainerManager.CONVERSATION_ID_LABEL_KEY}"}}`,
        containerName,
      ]);
      const [runningRaw, startedAtRaw, vaultIdRaw, conversationIdRaw] = stdout.trim().split("\t");
      const running = runningRaw === "true";
      const startedAtMs = this.parseDockerTimestamp(startedAtRaw);
      const vaultId = this.normalizeDockerValue(vaultIdRaw);
      const conversationId = this.normalizeDockerValue(conversationIdRaw);
      return { running, startedAtMs, vaultId, conversationId };
    } catch (err) {
      log.logWarning(
        `Failed to inspect container ${containerName} during reconcile`,
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    }
  }

  private normalizeDockerValue(value?: string): string | undefined {
    if (!value || value === "<no value>") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseDockerTimestamp(value?: string): number | undefined {
    const normalized = this.normalizeDockerValue(value);
    if (!normalized || normalized.startsWith("0001-")) return undefined;
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  private containerKeyFromContainerName(containerName: string): string | undefined {
    const prefix = DockerContainerManager.containerName("");
    if (!containerName.startsWith(prefix)) return undefined;
    const containerKey = containerName.slice(prefix.length);
    return containerKey.length > 0 ? containerKey : undefined;
  }

  private async forceRemoveContainer(
    containerName: string,
    successLog: string,
    failureLog: string,
  ): Promise<void> {
    try {
      await this.execFileImpl("docker", ["rm", "-f", containerName]);
      log.logInfo(successLog);
    } catch (err) {
      log.logWarning(failureLog, err instanceof Error ? err.message : String(err));
    }
  }

  private async removeLegacyContainer(containerName: string): Promise<void> {
    await this.forceRemoveContainer(
      containerName,
      `Removed legacy mikan container ${containerName} (pre-channel-isolation scheme)`,
      `Failed to remove legacy mikan container ${containerName}`,
    );
  }
}
