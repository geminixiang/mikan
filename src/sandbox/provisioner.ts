import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import * as log from "../log.js";
import { reportUserFacingError } from "../observability/index.js";

const execFileAsync = promisify(execFile);

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

import type {
  ContainerMount,
  DockerContainerManagerOptions,
  ProvisionOptions,
  ResourceLimits,
  SandboxLimitStatus,
} from "../types.js";
import { errorMessage } from "../unknown-values.js";
import type { DockerExecFile } from "./types.js";

export class DockerContainerManager {
  private state = new Map<string, ContainerState>();
  private inflight = new Map<string, Promise<string>>();
  private keyQueues = new Map<string, Promise<unknown>>();
  private static readonly MANAGED_LABEL = "mikan.managed=true";
  private static readonly IMAGE_MODE_LABEL = "mikan.sandbox=image";
  private static readonly VAULT_ID_LABEL_KEY = "mikan.vault-id";
  private static readonly CONVERSATION_ID_LABEL_KEY = "mikan.conversation-id";
  private static readonly MOUNT_SIGNATURE_LABEL_KEY = "mikan.mount-signature";

  private readonly limits?: ResourceLimits;
  private readonly boostLimits?: ResourceLimits;
  private readonly boostedKeys = new Set<string>();
  private readonly overrideLimits = new Map<string, ResourceLimits>();
  private readonly execFileImpl: DockerExecFile;

  constructor(
    private readonly image: string,
    options: DockerContainerManagerOptions = {},
  ) {
    this.limits = options.limits;
    this.boostLimits = options.boostLimits;
    this.execFileImpl = options.execFileImpl ?? execFileAsync;
  }

  static containerName(containerKey: string): string {
    return `mikan-sandbox-${containerKey}`;
  }

  static networkName(containerKey: string): string {
    return `mikan-sandbox-net-${containerKey}`;
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
    const status = await this.inspectStatus(containerName);

    try {
      const drift =
        status === "missing"
          ? undefined
          : await this.runtimeDrift(containerKey, containerName, mounts, status);
      if (drift) {
        log.logInfo(`Container ${containerName} is out of date (${drift}); replacing container`);
        await this.replaceContainer(containerKey, containerName, mounts, options);
        log.logInfo(`Container ${containerName} replaced from image ${this.image}`);
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

  remove(containerKey: string): Promise<void> {
    return this.serialize(containerKey, () => this.removeInner(containerKey));
  }

  private async removeInner(containerKey: string): Promise<void> {
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

  async reconcile(): Promise<void> {
    const names = await this.listContainerNamesByLabel();
    this.state.clear();

    const inspected = await Promise.all(
      names.map(async (containerName) => ({
        containerName,
        details: await this.inspectContainerDetails(containerName),
      })),
    );

    for (const { containerName, details } of inspected) {
      if (!details) continue;
      const containerKey = this.containerKeyFromContainerName(containerName);
      if (!containerKey) {
        log.logWarning(`Skipping unmanaged-style container without container key`, containerName);
        continue;
      }
      const status: ContainerStatus = details.running ? "running" : "stopped";
      const lastUsed = details.startedAtMs ?? Date.now();
      this.state.set(containerKey, { status, lastUsed, containerName });
    }

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
    status: ContainerStatus,
  ): Promise<DriftReason | undefined> {
    if (this.hasBindMountDrift(await this.inspectBindMounts(containerName), mounts)) return "binds";
    if (await this.hasMountSignatureDrift(containerName, mounts)) return "mount-content";
    if (await this.hasNetworkModeDrift(containerKey, containerName)) return "network";
    if (status === "stopped" && (await this.hasImageDrift(containerName))) return "image";
    return undefined;
  }

  private hasBindMountDrift(binds: readonly string[], mounts: ContainerMount[]): boolean {
    return !this.sameBinds(this.expectedBinds(mounts), [...binds]);
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

  private async replaceContainer(
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
}
