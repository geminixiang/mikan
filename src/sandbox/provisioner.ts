import { execFile } from "node:child_process";
import { legacyConversationResourceKey, sanitizeIdentitySegment } from "./identity.js";
import { GUEST_HOME, GUEST_PUBLIC_OFFICES_DIR } from "./layout.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import * as log from "../log.js";
import { reportUserFacingError } from "../observability/index.js";

const execFileAsync = promisify(execFile);
type ExecFileAsync = typeof execFileAsync;

type ContainerStatus = "running" | "stopped" | "missing";
type DriftReason = "binds" | "mount-content" | "network" | "image";

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
  ContainerBindTranslator,
  ContainerMount,
  DockerContainerManagerOptions,
  HomeVolumeMigrationOutcome,
  ManagedContainerInventoryEntry,
  ProvisionOptions,
  ResourceLimits,
  SandboxLimitStatus,
} from "../types.js";
import type {
  ContainerBindTranslator,
  ContainerMount,
  DockerContainerManagerOptions,
  HomeVolumeMigrationOutcome,
  ManagedContainerInventoryEntry,
  ProvisionOptions,
  ResourceLimits,
  SandboxLimitStatus,
} from "../types.js";
import { errorMessage } from "../unknown-values.js";

function bindSpecToMount(bindSpec: string): ContainerMount {
  const readOnly = bindSpec.endsWith(":ro");
  const spec = readOnly ? bindSpec.slice(0, -3) : bindSpec;
  const separator = spec.indexOf(":");
  return {
    source: spec.slice(0, separator),
    target: spec.slice(separator + 1),
    readOnly: readOnly ? true : undefined,
  };
}

export class DockerContainerManager {
  private state = new Map<string, ContainerState>();
  private inflight = new Map<string, Promise<string>>();
  private bindTranslator?: ContainerBindTranslator;
  private layoutMigrations = new Map<string, Promise<void>>();
  private keyQueues = new Map<string, Promise<unknown>>();
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

  static homeVolumeName(containerKey: string): string {
    return `mikan-home-${containerKey}`;
  }

  private serialize<T>(containerKey: string, task: () => Promise<T>): Promise<T> {
    const previous = this.keyQueues.get(containerKey) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    this.keyQueues.set(containerKey, settled);
    void settled.then(() => {
      if (this.keyQueues.get(containerKey) === settled) this.keyQueues.delete(containerKey);
    });
    return next;
  }

  async provision(containerKey: string, options: ProvisionOptions = {}): Promise<string> {
    const existing = this.inflight.get(containerKey);
    if (existing) return existing;

    const pending = this.serialize(containerKey, () =>
      this.provisionInner(containerKey, options),
    ).finally(() => {
      this.inflight.delete(containerKey);
    });
    this.inflight.set(containerKey, pending);
    return pending;
  }

  private async provisionInner(containerKey: string, options: ProvisionOptions): Promise<string> {
    const containerName =
      options.containerName ?? DockerContainerManager.containerName(containerKey);
    const mounts = options.mounts ?? [];
    await this.migrateContainerLayout(containerName);
    const status = await this.inspectStatus(containerName);

    try {
      const binds = status === "missing" ? [] : await this.inspectBindMounts(containerName);
      const homeVolume = this.hasHomeVolumeBind(containerKey, binds);
      const drift =
        status === "missing"
          ? undefined
          : await this.runtimeDrift(containerKey, containerName, mounts, {
              binds,
              status,
              homeVolume,
            });
      if (drift && homeVolume) {
        log.logInfo(`Container ${containerName} is out of date (${drift}); replacing container`);
        await this.replaceHomeVolumeContainer(containerKey, containerName, mounts, options);
        log.logInfo(`Container ${containerName} replaced from image ${this.image}`);
      } else if (drift) {
        log.logInfo(
          `Container ${containerName} configuration changed (${drift}); recreating container`,
        );
        await this.recreateContainerPreservingContents(containerKey, containerName, mounts);
        log.logInfo(`Container ${containerName} recreated`);
      } else if (status === "stopped") {
        await this.execFileImpl("docker", ["start", containerName]);
        log.logInfo(`Container ${containerName} started`);
      } else if (status === "missing") {
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

  stop(containerKey: string): Promise<void> {
    return this.serialize(containerKey, () => this.stopInner(containerKey));
  }

  private async stopInner(containerKey: string): Promise<void> {
    const containerName = this.getContainerName(containerKey);
    try {
      await this.execFileImpl("docker", ["stop", containerName]);
      this.setState(containerKey, "stopped", containerName);
      this.boostedKeys.delete(containerKey);
      this.overrideLimits.delete(containerKey);
      log.logInfo(`Container ${containerName} stopped (idle)`);
    } catch (err) {
      log.logWarning(`Failed to stop container ${containerName}`, errorMessage(err));
    }
  }

  remove(containerKey: string, options: { purgeHome?: boolean } = {}): Promise<void> {
    return this.serialize(containerKey, () => this.removeInner(containerKey, options));
  }

  private async removeInner(containerKey: string, options: { purgeHome?: boolean }): Promise<void> {
    const containerName = this.getContainerName(containerKey);
    const networkName = DockerContainerManager.networkName(containerKey);

    const removed = await this.forceRemoveContainer(
      containerName,
      `Container ${containerName} removed`,
      `Failed to remove container ${containerName}`,
    );
    if (!removed) {
      throw new Error(`Failed to remove container ${containerName}`);
    }

    try {
      await this.execFileImpl("docker", ["network", "rm", networkName]);
      log.logInfo(`Network ${networkName} removed`);
    } catch (err) {
      log.logWarning(`Failed to remove network ${networkName}`, errorMessage(err));
    }

    await this.removeMigrateSnapshot(containerName);
    if (options.purgeHome) await this.removeHomeVolume(containerKey);

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

  async removeContainersForConversations(conversationIds: ReadonlySet<string>): Promise<void> {
    if (conversationIds.size === 0) return;
    const names = await this.listContainerNamesByLabel();
    await Promise.all(
      names.map(async (containerName) => {
        const details = await this.inspectContainerDetails(containerName);
        if (!details?.conversationId || !conversationIds.has(details.conversationId)) return;
        const removed = await this.forceRemoveContainer(
          containerName,
          `Removed container ${containerName} after office migration`,
          `Failed to remove container ${containerName} after office migration`,
        );
        const containerKey = this.containerKeyFromContainerName(containerName);
        if (removed && containerKey) await this.removeHomeVolume(containerKey);
      }),
    );
  }

  armContainerLayoutMigration(translator: ContainerBindTranslator): void {
    this.bindTranslator = translator;
  }

  async sweepContainerLayoutMigration(delayMs = 2000): Promise<void> {
    if (!this.bindTranslator) return;
    let names: string[];
    try {
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
          errorMessage(err),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await this.removeDanglingMigrateImages();
  }

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
      const labeled = await this.readMigrateImageBinds(snapshotImage);
      if (labeled === undefined) return;
      originalBinds = labeled;
    } else {
      originalBinds = await this.inspectBindMounts(containerName);
      const translated = originalBinds.map(translator);
      if (this.sameBinds(translated.toSorted(), originalBinds.slice().toSorted())) {
        return;
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
    await this.removeMigrateSnapshot(containerName);
    log.logInfo(`Container ${containerName} migrated to the office layout`);
  }

  private async createContainerFromSnapshot(
    containerName: string,
    bindSpecs: string[],
    knownContainerKey?: string,
  ): Promise<void> {
    const snapshotImage = `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`;
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

  private async removeStaleMountpoints(
    containerName: string,
    bindSpecs: readonly string[],
  ): Promise<void> {
    const keep = new Set(
      bindSpecs
        .map((bind) => bindSpecToMount(bind).target)
        .filter((target) => target.startsWith(`${GUEST_PUBLIC_OFFICES_DIR}/`))
        .map((target) => target.slice(GUEST_PUBLIC_OFFICES_DIR.length + 1)),
    );
    const script = [
      `cd ${GUEST_PUBLIC_OFFICES_DIR} 2>/dev/null || exit 0`,
      "for d in *; do",
      '  [ -e "$d" ] || continue',
      '  case " $KEEP " in *" ${d##*/} "*) continue;; esac',
      '  rmdir "$d" 2>/dev/null || true',
      "done",
    ].join("\n");
    try {
      await this.execFileImpl("docker", [
        "exec",
        "-e",
        `KEEP=${[...keep].join(" ")}`,
        containerName,
        "sh",
        "-c",
        script,
      ]);
    } catch (err) {
      log.logWarning(`Could not clean stale mountpoints in ${containerName}`, String(err));
    }
  }

  private async recreateContainerPreservingContents(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
  ): Promise<void> {
    const snapshotImage = `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`;
    const bindSpecs = mounts.map((mount) => this.toBindSpec(mount));
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
    await this.removeStaleMountpoints(containerName, bindSpecs);
    await this.removeMigrateSnapshot(containerName);
  }

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

  private async removeMigrateSnapshot(containerName: string): Promise<void> {
    try {
      await this.execFileImpl("docker", [
        "rmi",
        `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`,
      ]);
    } catch {}
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
      if (status === "missing") continue;
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

      if (containerKey === legacyConversationResourceKey(details.conversationId)) {
        legacyRemovals.push(
          this.forceRemoveContainer(
            containerName,
            `Removed container ${containerName} keyed by pre-office resource identity`,
            `Failed to remove legacy-keyed container ${containerName}`,
          ).then(() => undefined),
        );
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
    return `${mount.source}:${mount.target}${mount.readOnly ? ":ro" : ""}`;
  }

  private async runContainer(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
    options: ProvisionOptions,
  ): Promise<void> {
    const networkName = await this.ensureNetwork(containerKey);
    const homeVolume = await this.ensureHomeVolume(containerKey);
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
      "-v",
      `${homeVolume}:${GUEST_HOME}`,
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
        errorMessage(err),
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

  private async runtimeDrift(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
    current: { binds: readonly string[]; status: ContainerStatus; homeVolume: boolean },
  ): Promise<DriftReason | undefined> {
    const { binds, status, homeVolume } = current;
    if (this.hasBindMountDrift(binds, mounts)) return "binds";
    if (await this.hasMountSignatureDrift(containerName, mounts)) return "mount-content";
    if (await this.hasNetworkModeDrift(containerKey, containerName)) return "network";
    if (homeVolume && status === "stopped" && (await this.hasImageDrift(containerName))) {
      return "image";
    }
    return undefined;
  }

  private hasBindMountDrift(binds: readonly string[], mounts: ContainerMount[]): boolean {
    const expected = this.expectedBinds(mounts);
    const actual = binds.filter((bind) => !this.isHomeVolumeBind(bind));
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
        return createHash("sha256").update(readFileSync(source)).digest("hex");
      }
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

  private isHomeVolumeBind(bind: string): boolean {
    const separator = bind.indexOf(":");
    if (separator === -1) return false;
    const source = bind.slice(0, separator);
    const target = bind.slice(separator + 1).replace(/:r[ow]$/, "");
    return source.startsWith(DockerContainerManager.homeVolumeName("")) && target === GUEST_HOME;
  }

  private hasHomeVolumeBind(containerKey: string, binds: readonly string[]): boolean {
    const expected = `${DockerContainerManager.homeVolumeName(containerKey)}:${GUEST_HOME}`;
    return binds.includes(expected);
  }

  private async hasHomeVolume(containerKey: string, containerName: string): Promise<boolean> {
    return this.hasHomeVolumeBind(containerKey, await this.inspectBindMounts(containerName));
  }

  private async hasImageDrift(containerName: string): Promise<boolean> {
    const desired = await this.localImageId();
    if (!desired) return false;
    const { stdout } = await this.execFileImpl("docker", [
      "inspect",
      "-f",
      "{{.Image}}",
      containerName,
    ]);
    return stdout.trim() !== desired;
  }

  private async localImageId(): Promise<string | undefined> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "image",
        "inspect",
        "-f",
        "{{.Id}}",
        this.image,
      ]);
      return this.normalizeDockerValue(stdout.trim());
    } catch {
      return undefined;
    }
  }

  private async ensureHomeVolume(containerKey: string): Promise<string> {
    const volumeName = DockerContainerManager.homeVolumeName(containerKey);
    await this.execFileImpl("docker", [
      "volume",
      "create",
      "--label",
      DockerContainerManager.MANAGED_LABEL,
      "--label",
      `${DockerContainerManager.VAULT_ID_LABEL_KEY}=${containerKey}`,
      volumeName,
    ]);
    return volumeName;
  }

  private async removeHomeVolume(containerKey: string): Promise<void> {
    const volumeName = DockerContainerManager.homeVolumeName(containerKey);
    try {
      await this.execFileImpl("docker", ["volume", "rm", volumeName]);
      log.logInfo(`Home volume ${volumeName} removed`);
    } catch (err) {
      if (isDockerNotFoundError(err)) return;
      log.logWarning(`Failed to remove home volume ${volumeName}`, errorMessage(err));
    }
  }

  private async replaceHomeVolumeContainer(
    containerKey: string,
    containerName: string,
    mounts: ContainerMount[],
    options: ProvisionOptions,
  ): Promise<void> {
    const removed = await this.forceRemoveContainer(
      containerName,
      `Container ${containerName} removed for replacement`,
      `Failed to remove container ${containerName} for replacement`,
    );
    if (!removed) throw new Error(`Failed to remove container ${containerName} for replacement`);
    await this.runContainer(containerKey, containerName, mounts, options);
  }

  async inventory(): Promise<ManagedContainerInventoryEntry[]> {
    const names = await this.listContainerNamesByLabel();
    const entries: ManagedContainerInventoryEntry[] = [];
    for (const containerName of names) {
      const containerKey = this.containerKeyFromContainerName(containerName);
      const status = await this.inspectStatus(containerName);
      if (status === "missing") continue;
      const homeVolume = containerKey
        ? await this.hasHomeVolume(containerKey, containerName)
        : false;
      entries.push({
        containerName,
        containerKey,
        running: status === "running",
        homeVolume,
        imageStale: await this.hasImageDrift(containerName),
      });
    }
    return entries;
  }

  async systemChanges(containerName: string): Promise<string[]> {
    const { stdout } = await this.execFileImpl("docker", ["diff", containerName]);
    return this.parseNameLines(stdout).filter((line) => {
      const path = line.slice(2);
      return !this.isUnderGuestPath(path, GUEST_HOME) && !this.isUnderGuestPath(path, "/workspace");
    });
  }

  private isUnderGuestPath(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
  }

  migrateToHomeVolume(containerKey: string): Promise<HomeVolumeMigrationOutcome> {
    return this.serialize(containerKey, () => this.migrateToHomeVolumeInner(containerKey));
  }

  private async migrateToHomeVolumeInner(
    containerKey: string,
  ): Promise<HomeVolumeMigrationOutcome> {
    const containerName = DockerContainerManager.containerName(containerKey);
    const status = await this.inspectStatus(containerName);
    if (status === "missing") return "missing";
    if (await this.hasHomeVolume(containerKey, containerName)) return "already-migrated";

    const details = await this.inspectContainerDetails(containerName);
    const mounts = (await this.inspectBindMounts(containerName))
      .filter((bind) => !this.isHomeVolumeBind(bind))
      .map(bindSpecToMount);
    const snapshotImage = `${DockerContainerManager.MIGRATE_IMAGE_PREFIX}:${containerName}`;
    log.logInfo(`Migrating container ${containerName} to a home volume`);
    await this.execFileImpl("docker", ["commit", containerName, snapshotImage]);
    const homeVolume = await this.ensureHomeVolume(containerKey);
    await this.execFileImpl("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${homeVolume}:${GUEST_HOME}`,
      snapshotImage,
      "true",
    ]);
    const removed = await this.forceRemoveContainer(
      containerName,
      `Container ${containerName} removed for home-volume migration`,
      `Failed to remove container ${containerName} for home-volume migration`,
    );
    if (!removed) throw new Error(`Failed to remove container ${containerName}`);
    await this.runContainer(
      containerKey,
      containerName,
      mounts,
      details?.conversationId ? { conversationId: details.conversationId } : {},
    );
    if (status === "stopped") await this.execFileImpl("docker", ["stop", containerName]);
    await this.removeMigrateSnapshot(containerName);
    this.setState(containerKey, status === "stopped" ? "stopped" : "running", containerName);
    log.logInfo(`Container ${containerName} migrated to home volume ${homeVolume}`);
    return "migrated";
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
      log.logWarning("Failed to list labeled managed containers", errorMessage(err));
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
      log.logWarning("Failed to list legacy managed containers", errorMessage(err));
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
  ): Promise<{ running: boolean; startedAtMs?: number; conversationId?: string } | undefined> {
    try {
      const { stdout } = await this.execFileImpl("docker", [
        "inspect",
        "-f",
        `{{.State.Running}}\t{{.State.StartedAt}}\t{{index .Config.Labels "${DockerContainerManager.VAULT_ID_LABEL_KEY}"}}\t{{index .Config.Labels "${DockerContainerManager.CONVERSATION_ID_LABEL_KEY}"}}`,
        containerName,
      ]);
      const [runningRaw, startedAtRaw, , conversationIdRaw] = stdout.trim().split("\t");
      const running = runningRaw === "true";
      const startedAtMs = this.parseDockerTimestamp(startedAtRaw);
      const conversationId = this.normalizeDockerValue(conversationIdRaw);
      return { running, startedAtMs, conversationId };
    } catch (err) {
      log.logWarning(
        `Failed to inspect container ${containerName} during reconcile`,
        errorMessage(err),
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
  ): Promise<boolean> {
    try {
      await this.execFileImpl("docker", ["rm", "-f", containerName]);
      log.logInfo(successLog);
      return true;
    } catch (err) {
      const message = errorMessage(err);
      if (/no such container/i.test(message)) return true;
      log.logWarning(failureLog, message);
      return false;
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
