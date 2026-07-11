/**
 * Extension discovery and activation.
 *
 * Extension modules execute inside the mikan host process with its full
 * privileges (platform tokens, vault, host filesystem). They must therefore
 * only ever load from host-controlled directories: installing an extension
 * is an administrator action. In particular, extension directories must not
 * live under paths mounted into sandbox containers (workspace and
 * conversation dirs in image mode), or code written from inside the sandbox
 * would be imported into the host process — a sandbox escape.
 * {@link defaultExtensionDirs} returns the canonical host-only locations
 * under mikan's state dir.
 *
 * Directories are scanned in order; all discovered extensions activate.
 * Accepted layouts:
 *
 * - `extensions/<name>.mjs` / `extensions/<name>.js`
 * - `extensions/<name>/index.mjs` / `extensions/<name>/index.js`
 *
 * Modules are imported with a cache-busting query so edited extensions are
 * picked up when a new harness instance is created for a conversation.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { pathToFileURL } from "url";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as log from "../../log.js";
import { loadSkillsFromDir, type MikanSkill } from "../skills.js";
import { ExtensionRegistry } from "./registry.js";
import type {
  ExtensionHostServices,
  ExtensionLoadError,
  ExtensionManifest,
  ExtensionSchedulePayload,
  ExtensionScheduleInfo,
  ExtensionScheduleSpec,
  LoadedExtension,
  MikanExtensionActivate,
  MikanExtensionApi,
  MikanExtensionModule,
} from "./types.js";

const EXTENSION_FILE_PATTERN = /\.(mjs|js)$/;

/**
 * Canonical host-only extension directories for a conversation:
 * `<stateDir>/extensions/global` (all conversations) and
 * `<stateDir>/extensions/<conversationId>` (that conversation only).
 * `global` is reserved as a scope name; platform conversation ids never
 * take that value.
 */
export function defaultExtensionDirs(
  conversationId: string,
  stateDir: string = join(homedir(), ".mikan"),
): string[] {
  return [join(stateDir, "extensions", "global"), join(stateDir, "extensions", conversationId)];
}

/** Discovery-only view of an installed extension (module is not imported). */
export interface InstalledExtensionInfo {
  /** Display name: manifest name, falling back to the slug. */
  name: string;
  slug: string;
  path: string;
  /** Scan directory the extension was found in. */
  dir: string;
  version?: string;
  description?: string;
  /** Names of skills shipped in the extension's skills/ directory. */
  skillNames: string[];
}

/**
 * List installed extensions without importing or activating them — safe for
 * inventory surfaces (commands, portal). Activation side effects (schedule
 * upserts, tool registration) only happen in {@link loadExtensions}.
 */
export function listInstalledExtensions(dirs: string[]): InstalledExtensionInfo[] {
  const infos: InstalledExtensionInfo[] = [];
  for (const dir of dirs) {
    for (const entrypoint of discoverExtensionEntrypoints(dir)) {
      const slug = extensionSlug(entrypoint);
      const manifest = readManifest(entrypoint);
      infos.push({
        name: manifest.name ?? slug,
        slug,
        path: entrypoint,
        dir,
        version: manifest.version,
        description: manifest.description,
        skillNames: loadExtensionSkills(entrypoint, slug).map((skill) => skill.name),
      });
    }
  }
  return infos;
}

export interface LoadExtensionsOptions {
  /** Directories to scan for extensions. Missing directories are skipped. */
  dirs: string[];
  context: {
    conversationId: string;
    workspaceDir: string;
    model: Model<Api>;
    thinkingLevel: ThinkingLevel;
  };
  /** Embedder-provided services backing the v2 api surface. */
  services?: ExtensionHostServices;
}

export interface LoadExtensionsResult {
  registry: ExtensionRegistry;
  extensions: LoadedExtension[];
  errors: ExtensionLoadError[];
  /** Skills contributed by extensions (inline: bodies ride in the prompt). */
  skills: MikanSkill[];
}

function discoverExtensionEntrypoints(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entrypoints: string[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (name.startsWith(".")) continue;
    const fullPath = join(dir, name);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isFile() && EXTENSION_FILE_PATTERN.test(name)) {
      entrypoints.push(fullPath);
      continue;
    }
    if (stats.isDirectory()) {
      for (const candidate of ["index.mjs", "index.js"]) {
        const indexPath = join(fullPath, candidate);
        if (existsSync(indexPath)) {
          entrypoints.push(indexPath);
          break;
        }
      }
    }
  }
  return entrypoints;
}

/**
 * Filesystem-safe identifier for an extension, derived from its install
 * location (directory name for `<name>/index.mjs`, file basename otherwise).
 * The slug keys the extension's data dir, secrets vault, and schedule
 * ownership — installing the same extension globally and per-conversation
 * shares one slug and therefore one data dir.
 */
export function extensionSlug(entrypoint: string): string {
  const base = /^index\.(mjs|js)$/.test(basename(entrypoint))
    ? basename(dirname(entrypoint))
    : basename(entrypoint).replace(EXTENSION_FILE_PATTERN, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "extension";
}

/** Sanitize an extension-chosen schedule name into a filename segment. */
function scheduleNameSegment(name: string): string {
  const segment = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!segment) throw new Error(`Invalid schedule name: ${JSON.stringify(name)}`);
  return segment;
}

/** Read `manifest.json` next to a directory-form extension's entrypoint. */
function readManifest(entrypoint: string): ExtensionManifest {
  if (!/^index\.(mjs|js)$/.test(basename(entrypoint))) return {};
  const manifestPath = join(dirname(entrypoint), "manifest.json");
  if (!existsSync(manifestPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : undefined,
      version: typeof record.version === "string" ? record.version : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
    };
  } catch (err) {
    log.logWarning(`Ignoring malformed extension manifest: ${manifestPath}`, String(err));
    return {};
  }
}

/**
 * Skills shipped inside a directory-form extension (`<dir>/skills/`).
 * Marked inline: extension files live under the host-only state dir, which
 * sandbox containers cannot read, so skill bodies must ride in the prompt.
 */
function loadExtensionSkills(entrypoint: string, slug: string): MikanSkill[] {
  if (!/^index\.(mjs|js)$/.test(basename(entrypoint))) return [];
  const skillsDir = join(dirname(entrypoint), "skills");
  if (!existsSync(skillsDir)) return [];
  const result = loadSkillsFromDir({ dir: skillsDir, source: `extension:${slug}` });
  for (const diagnostic of result.diagnostics) {
    log.logWarning(`Extension skill warning (${slug}): ${diagnostic.message}`, diagnostic.path);
  }
  for (const skill of result.skills) skill.inline = true;
  return result.skills;
}

const SCHEDULE_FILE_SUFFIX = ".json";

function schedulePrefix(slug: string, conversationId: string): string {
  return `ext.${slug}.${scheduleNameSegment(conversationId)}.`;
}

function payloadFromSpec(
  spec: ExtensionScheduleSpec,
  conversationId: string,
): ExtensionSchedulePayload {
  if (spec.type === "periodic") {
    if (!spec.schedule || !spec.timezone) {
      throw new Error("periodic schedule requires schedule and timezone");
    }
    return {
      type: "periodic",
      conversationId,
      text: spec.text,
      schedule: spec.schedule,
      timezone: spec.timezone,
      ...(spec.platform ? { platform: spec.platform } : {}),
    };
  }
  if (!spec.at) throw new Error("one-shot schedule requires at");
  return {
    type: "one-shot",
    conversationId,
    text: spec.text,
    at: spec.at,
    ...(spec.platform ? { platform: spec.platform } : {}),
  };
}

function specFromPayload(payload: ExtensionSchedulePayload): ExtensionScheduleSpec {
  if (payload.type === "periodic") {
    return {
      type: "periodic",
      schedule: payload.schedule ?? "",
      timezone: payload.timezone ?? "",
      text: payload.text,
      ...(payload.platform ? { platform: payload.platform } : {}),
    };
  }
  return {
    type: "one-shot",
    at: payload.at ?? "",
    text: payload.text,
    ...(payload.platform ? { platform: payload.platform } : {}),
  };
}

/** Build the v2 api surface for one extension over the injected services. */
function buildExtensionApi(params: {
  name: string;
  slug: string;
  registry: ExtensionRegistry;
  context: LoadExtensionsOptions["context"];
  services: ExtensionHostServices;
}): MikanExtensionApi {
  const { name, slug, registry, context, services } = params;
  const stateDir = services.stateDir ?? join(homedir(), ".mikan");
  const conversationId = context.conversationId;

  const requireScheduleStore = () => {
    if (!services.scheduleStore) {
      throw new Error("api.schedules is unavailable: this context provides no schedule store");
    }
    return services.scheduleStore;
  };

  return {
    on: (hook, handler) => registry.register(name, hook, handler),
    registerTool: (tool: AgentTool) => registry.registerTool(tool),
    log: (message: string) => log.logInfo(`[extension:${name}] ${message}`),
    context,
    paths: {
      get dataDir(): string {
        const dir = join(stateDir, "extension-data", slug);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
    },
    secrets: {
      get: (key: string) => services.resolveSecrets?.(slug)[key],
      list: () => Object.keys(services.resolveSecrets?.(slug) ?? {}),
    },
    schedules: {
      upsert: async (scheduleName, spec) => {
        const store = requireScheduleStore();
        const filename = `${schedulePrefix(slug, conversationId)}${scheduleNameSegment(scheduleName)}${SCHEDULE_FILE_SUFFIX}`;
        await store.write(filename, payloadFromSpec(spec, conversationId));
      },
      delete: async (scheduleName) => {
        const store = requireScheduleStore();
        const filename = `${schedulePrefix(slug, conversationId)}${scheduleNameSegment(scheduleName)}${SCHEDULE_FILE_SUFFIX}`;
        return store.delete(filename);
      },
      list: async () => {
        const store = requireScheduleStore();
        const prefix = schedulePrefix(slug, conversationId);
        const infos: ExtensionScheduleInfo[] = [];
        for (const entry of await store.list()) {
          if (!entry.filename.startsWith(prefix)) continue;
          if (!entry.filename.endsWith(SCHEDULE_FILE_SUFFIX)) continue;
          infos.push({
            name: entry.filename.slice(prefix.length, -SCHEDULE_FILE_SUFFIX.length),
            spec: specFromPayload(entry.payload),
          });
        }
        return infos;
      },
    },
    notify: async (text: string) => {
      if (!services.postMessage) {
        throw new Error("api.notify is unavailable: this context provides no platform messaging");
      }
      await services.postMessage(conversationId, text);
    },
  };
}

function resolveActivate(moduleExports: unknown): MikanExtensionModule | undefined {
  if (!moduleExports || typeof moduleExports !== "object") return undefined;
  const candidates: unknown[] = [(moduleExports as { default?: unknown }).default, moduleExports];
  for (const candidate of candidates) {
    if (typeof candidate === "function") {
      return { activate: candidate as MikanExtensionActivate };
    }
    if (candidate && typeof candidate === "object") {
      const activate = (candidate as { activate?: unknown }).activate;
      if (typeof activate === "function") {
        return {
          name:
            typeof (candidate as { name?: unknown }).name === "string"
              ? (candidate as { name: string }).name
              : undefined,
          activate: activate as MikanExtensionActivate,
        };
      }
    }
  }
  return undefined;
}

/** Load and activate all extensions found in the given directories. */
export async function loadExtensions(
  options: LoadExtensionsOptions,
): Promise<LoadExtensionsResult> {
  const registry = new ExtensionRegistry();
  const extensions: LoadedExtension[] = [];
  const errors: ExtensionLoadError[] = [];
  const skills: MikanSkill[] = [];
  const services = options.services ?? {};

  for (const dir of options.dirs) {
    for (const entrypoint of discoverExtensionEntrypoints(dir)) {
      try {
        const moduleUrl = `${pathToFileURL(entrypoint).href}?t=${Date.now()}`;
        const moduleExports: unknown = await import(moduleUrl);
        const extension = resolveActivate(moduleExports);
        if (!extension) {
          errors.push({
            path: entrypoint,
            error: "extension must export an activate function (default or named)",
          });
          continue;
        }
        const slug = extensionSlug(entrypoint);
        const manifest = readManifest(entrypoint);
        const name = manifest.name ?? extension.name ?? slug;
        const api = buildExtensionApi({
          name,
          slug,
          registry,
          context: options.context,
          services,
        });
        await extension.activate(api);
        const extensionSkills = loadExtensionSkills(entrypoint, slug);
        skills.push(...extensionSkills);
        extensions.push({
          name,
          path: entrypoint,
          slug,
          version: manifest.version,
          description: manifest.description,
          skills: extensionSkills,
        });
      } catch (err) {
        errors.push({
          path: entrypoint,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { registry, extensions, errors, skills };
}
