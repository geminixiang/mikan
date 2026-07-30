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
 * Accepted layouts (entrypoint may be .mjs/.js/.ts/.mts — loaded via jiti):
 *
 * - `extensions/<name>.<ext>`                     (bare file)
 * - `extensions/<name>/index.<ext>`               (directory + index)
 * - `extensions/<name>/package.json`              (mikan.extensions entrypoint;
 *   may carry npm dependencies in node_modules)
 *
 * Modules are imported with a fresh jiti instance (no cache) so edited
 * extensions are picked up when a new harness instance is created.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createJiti } from "jiti";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import * as log from "../../log.js";
import { buildEventPayload } from "../event-format.js";
import { loadSkillsFromDir } from "../skills.js";
import type { MikanSkill } from "../types.js";
import { ExtensionRegistry, namespaceActionIds } from "./registry.js";
import { officeStateDir } from "../../office/index.js";
import type { OfficeAddress } from "../../types.js";
import type {
  ExtensionCommand,
  ExtensionDisposer,
  ExtensionHostServices,
  ExtensionLoadError,
  ExtensionManifest,
  ExtensionSchedulePayload,
  ExtensionScheduleInfo,
  ExtensionScheduleSpec,
  ExtensionValidation,
  InstalledExtensionInfo,
  LoadExtensionsOptions,
  LoadExtensionsResult,
  LoadedExtension,
  MikanExtensionActivate,
  MikanExtensionApi,
  MikanExtensionModule,
} from "./types.js";

export type {
  ExtensionValidation,
  InstalledExtensionInfo,
  LoadExtensionsOptions,
  LoadExtensionsResult,
} from "./types.js";

const EXTENSION_FILE_PATTERN = /\.(mjs|js|ts|mts)$/;
const INDEX_FILE_PATTERN = /^index\.(mjs|js|ts|mts)$/;
const INDEX_CANDIDATES = ["index.mjs", "index.js", "index.ts", "index.mts"];

/**
 * Import an extension entrypoint through jiti so it can be TypeScript and can
 * use node_modules dependencies, transparently compiling on the fly. A fresh
 * jiti instance with caching disabled is used per load so edited extensions
 * are picked up when a new harness instance is created for a conversation.
 */
async function importExtensionModule(entrypoint: string): Promise<unknown> {
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  return jiti.import(entrypoint);
}

/**
 * Canonical host-only extension code directories for a conversation, in load
 * order: `<stateDir>/global/extensions` (all conversations) then
 * `<stateDir>/conversations/<office key>/extensions` (that conversation
 * only). `global` and `conversations` are the two sibling scopes; see
 * `LAYOUT.md`.
 */
export function defaultExtensionDirs(
  address: OfficeAddress,
  stateDir: string = join(homedir(), ".mikan"),
): string[] {
  return [
    join(stateDir, "global", "extensions"),
    join(officeStateDir(stateDir, address), "extensions"),
  ];
}

/**
 * List installed extensions without importing or activating them — safe for
 * inventory surfaces (commands, portal). Activation side effects (schedule
 * upserts, tool registration) only happen in {@link loadExtensions}.
 */
export function listInstalledExtensions(dirs: string[]): InstalledExtensionInfo[] {
  const infos: InstalledExtensionInfo[] = [];
  for (const dir of dirs) {
    for (const { entrypoint, rootDir } of discoverExtensionEntrypoints(dir)) {
      const slug = extensionSlug(rootDir);
      const manifest = readManifest(rootDir);
      infos.push({
        name: manifest.name ?? slug,
        slug,
        path: entrypoint,
        dir,
        version: manifest.version,
        description: manifest.description,
        skillNames: loadExtensionSkills(rootDir, slug).map((skill) => skill.name),
      });
    }
  }
  return infos;
}

/**
 * A discovered extension: its entrypoint (module to import) and root dir
 * (used for slug, manifest.json, and skills/ — which sit at the extension
 * root, not necessarily next to a nested entrypoint).
 */
interface DiscoveredExtension {
  entrypoint: string;
  rootDir: string;
  /** Derived from rootDir; carried here so dedup and activation cannot disagree. */
  slug: string;
}

function discoverExtensionEntrypoints(dir: string): DiscoveredExtension[] {
  if (!existsSync(dir)) return [];
  const found: DiscoveredExtension[] = [];
  for (const name of readdirSync(dir).toSorted()) {
    if (name.startsWith(".")) continue;
    if (INDEX_FILE_PATTERN.test(name)) {
      // An index file at the scan root means the extension's contents were
      // copied into the scope directory itself; the slug would degenerate to
      // the scope name (e.g. the conversation id), mis-keying its data dir,
      // secrets, and schedules. Require a named form instead.
      log.logWarning(
        `Ignoring extension index file at scope root: ${join(dir, name)}`,
        "install into a named subdirectory (e.g. extensions/<scope>/my-ext/index.mjs)",
      );
      continue;
    }
    const fullPath = join(dir, name);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }
    if (stats.isFile() && EXTENSION_FILE_PATTERN.test(name)) {
      // Bare-file form: the file is both entrypoint and (its own) root.
      found.push({ entrypoint: fullPath, rootDir: fullPath, slug: extensionSlug(fullPath) });
      continue;
    }
    if (stats.isDirectory()) {
      const entrypoint = resolveDirectoryEntrypoint(fullPath);
      if (entrypoint) {
        found.push({ entrypoint, rootDir: fullPath, slug: extensionSlug(fullPath) });
      }
    }
  }
  return found;
}

/**
 * Resolve a directory-form extension's entrypoint. A `package.json` with a
 * `mikan.extensions` array (first entry, relative to the dir) wins — this is
 * how an extension declares a TypeScript entry and pulls in npm dependencies.
 * Otherwise fall back to an `index.{mjs,js,ts,mts}` file. Returns undefined
 * when neither is present.
 */
function resolveDirectoryEntrypoint(dir: string): string | undefined {
  const declared = readMikanManifestEntrypoints(dir)[0];
  if (declared) {
    const resolved = join(dir, declared);
    if (existsSync(resolved)) return resolved;
    log.logWarning(
      `Extension package.json declares a missing entrypoint: ${resolved}`,
      "falling back to an index file",
    );
  }
  for (const candidate of INDEX_CANDIDATES) {
    const indexPath = join(dir, candidate);
    if (existsSync(indexPath)) return indexPath;
  }
  return undefined;
}

interface ExtensionPackageJson {
  name?: string;
  version?: string;
  description?: string;
  mikan?: { extensions?: string[]; displayName?: string };
}

/** Read and shape a directory's package.json; undefined when absent/malformed. */
function readPackageJson(dir: string): ExtensionPackageJson | undefined {
  const packageJsonPath = join(dir, "package.json");
  if (!existsSync(packageJsonPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const mikanRaw = record.mikan as { extensions?: unknown; displayName?: unknown } | undefined;
    return {
      name: typeof record.name === "string" ? record.name : undefined,
      version: typeof record.version === "string" ? record.version : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      mikan: {
        extensions: Array.isArray(mikanRaw?.extensions)
          ? mikanRaw.extensions.filter((entry): entry is string => typeof entry === "string")
          : undefined,
        displayName: typeof mikanRaw?.displayName === "string" ? mikanRaw.displayName : undefined,
      },
    };
  } catch (err) {
    log.logWarning(`Ignoring malformed package.json: ${packageJsonPath}`, String(err));
    return undefined;
  }
}

/** Read the `mikan.extensions` entrypoint list from a directory's package.json. */
function readMikanManifestEntrypoints(dir: string): string[] {
  return readPackageJson(dir)?.mikan?.extensions ?? [];
}

/** The one filesystem-safe segment sanitizer for extension identity and schedule names. */
function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function sanitizeSlug(base: string): string {
  return sanitizeSegment(base) || "extension";
}

/**
 * Filesystem-safe identifier for an extension, derived from its root (the
 * install directory, or the file path for a bare-file extension). The slug
 * keys the extension's data dir, secrets vault, and schedule ownership —
 * installing the same extension globally and per-conversation shares one
 * slug and therefore one shared data dir. This is the only slug derivation:
 * a second one keyed off a different input (e.g. the entrypoint, which for
 * package.json-form extensions can live under dist/) would silently split an
 * extension's identity.
 */
export function extensionSlug(rootDir: string): string {
  return EXTENSION_FILE_PATTERN.test(basename(rootDir))
    ? sanitizeSlug(basename(rootDir).replace(EXTENSION_FILE_PATTERN, ""))
    : sanitizeSlug(basename(rootDir));
}

/** Sanitize an extension-chosen schedule name into a filename segment. */
function scheduleNameSegment(name: string): string {
  const segment = sanitizeSegment(name);
  if (!segment) throw new Error(`Invalid schedule name: ${JSON.stringify(name)}`);
  return segment;
}

/**
 * Read display metadata (name/version/description) for a directory-form
 * extension. `package.json` is the primary source — its standard `name`,
 * `version`, `description`, plus an optional `mikan.displayName` that
 * overrides the npm name for the user-facing label (npm names are
 * lowercase/scoped; display names can be arbitrary). A `manifest.json` is a
 * fallback for extensions that ship no package.json.
 */
function readManifest(rootDir: string): ExtensionManifest {
  // Bare-file extensions (rootDir is a *.mjs/.ts file) have no manifest.
  if (EXTENSION_FILE_PATTERN.test(basename(rootDir))) return {};

  const pkg = readPackageJson(rootDir);
  if (pkg && (pkg.mikan?.displayName ?? pkg.name ?? pkg.version ?? pkg.description)) {
    return {
      name: pkg.mikan?.displayName ?? pkg.name,
      version: pkg.version,
      description: pkg.description,
    };
  }

  const manifestPath = join(rootDir, "manifest.json");
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
function loadExtensionSkills(rootDir: string, slug: string): MikanSkill[] {
  // Bare-file extensions (rootDir is a *.mjs/.ts file) ship no skills.
  if (EXTENSION_FILE_PATTERN.test(basename(rootDir))) return [];
  const skillsDir = join(rootDir, "skills");
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
  // Per-type validation (schedule/timezone for periodic, at for one-shot)
  // is owned by the event-format builder.
  return buildEventPayload({
    type: spec.type,
    conversationId,
    text: spec.text,
    ...(spec.platform ? { platform: spec.platform } : {}),
    ...(spec.type === "periodic"
      ? { schedule: spec.schedule, timezone: spec.timezone }
      : { at: spec.at }),
  });
}

function specFromPayload(payload: ExtensionSchedulePayload): ExtensionScheduleSpec {
  if (payload.type === "periodic") {
    return {
      type: "periodic",
      schedule: payload.schedule,
      timezone: payload.timezone,
      text: payload.text,
      ...(payload.platform ? { platform: payload.platform } : {}),
    };
  }
  // `immediate` payloads never appear under the schedules namespace (they
  // live under "extrun."); tolerate them as an empty one-shot rather than
  // widening the spec union.
  return {
    type: "one-shot",
    at: payload.type === "one-shot" ? payload.at : "",
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
  const conversationStateDir = officeStateDir(stateDir, context.address);

  const requireScheduleStore = () => {
    if (!services.scheduleStore) {
      throw new Error("api.schedules is unavailable: this context provides no schedule store");
    }
    return services.scheduleStore;
  };

  return {
    on: (hook, handler) => registry.register(name, hook, handler),
    registerTool: (tool: AgentTool) => registry.registerTool(tool),
    registerCommand: (command: ExtensionCommand) => registry.registerCommand(name, command),
    onDispose: (disposer: ExtensionDisposer) => registry.registerDisposer(name, disposer),
    log: (message: string) => log.logInfo(`[extension:${name}] ${message}`),
    context,
    paths: {
      get dataDir(): string {
        // This conversation's own data, co-located with the conversation's
        // other host-only assets; removed when the conversation is deleted.
        const dir = join(conversationStateDir, "extension-data", slug);
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      get sharedDataDir(): string {
        // Cross-conversation data under the sibling `global` scope.
        const dir = join(stateDir, "global", "extension-data", slug);
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
    subagent: {
      run: async (request) => {
        if (!services.runSubagent) {
          throw new Error("api.subagent is unavailable: this context provides no subagent runner");
        }
        return services.runSubagent(request, registry.getContributedTools());
      },
    },
    notify: async (text: string, options?: { conversationId?: string }) => {
      if (!services.postMessage) {
        throw new Error("api.notify is unavailable: this context provides no platform messaging");
      }
      await services.postMessage(options?.conversationId ?? conversationId, text);
    },
    blockkit: {
      post: async (message) => {
        if (!services.postBlocks) {
          throw new Error(
            "api.blockkit is unavailable: this context provides no Block Kit messaging",
          );
        }
        return services.postBlocks(conversationId, {
          text: message.text,
          blocks: namespaceActionIds(message.blocks, slug),
          threadTs: message.threadTs,
        });
      },
      update: async (messageTs, message) => {
        if (!services.updateBlocks) {
          throw new Error(
            "api.blockkit is unavailable: this context provides no Block Kit messaging",
          );
        }
        await services.updateBlocks(conversationId, messageTs, {
          text: message.text,
          blocks: namespaceActionIds(message.blocks, slug),
        });
      },
      onAction: (actionId, handler) => registry.registerAction(slug, actionId, handler),
    },
    react: async (messageTs: string, emoji: string) => {
      if (!services.addReaction) {
        throw new Error("api.react is unavailable: this context provides no reaction support");
      }
      await services.addReaction(conversationId, messageTs, emoji);
    },
    uploadFile: async (filePath: string, title?: string) => {
      if (!services.uploadFile) {
        throw new Error("api.uploadFile is unavailable: this context provides no file uploads");
      }
      await services.uploadFile(conversationId, filePath, title);
    },
    triggerRun: async (text: string) => {
      const store = requireScheduleStore();
      // Distinct "extrun." namespace: run files must never surface in
      // api.schedules.list(), whose ownership filter is the "ext." prefix.
      // The embedder's watcher fires and deletes the file immediately.
      const filename = `extrun.${slug}.${scheduleNameSegment(conversationId)}.${Date.now()}-${runCounter++}${SCHEDULE_FILE_SUFFIX}`;
      await store.write(filename, { type: "immediate", conversationId, text });
    },
  };
}

/** Monotonic suffix so rapid triggerRun calls in one process never collide. */
let runCounter = 0;

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

  for (const { entrypoint, rootDir, slug } of collectExtensions(options)) {
    try {
      const moduleExports: unknown = await importExtensionModule(entrypoint);
      const extension = resolveActivate(moduleExports);
      if (!extension) {
        errors.push({
          path: entrypoint,
          error: "extension must export an activate function (default or named)",
        });
        continue;
      }
      const manifest = readManifest(rootDir);
      const name = manifest.name ?? extension.name ?? slug;
      const api = buildExtensionApi({
        name,
        slug,
        registry,
        context: options.context,
        services,
      });
      const disposer = await extension.activate(api);
      if (typeof disposer === "function") registry.registerDisposer(name, disposer);
      const extensionSkills = loadExtensionSkills(rootDir, slug);
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

  return { registry, extensions, errors, skills, dispose: () => registry.dispose() };
}

/**
 * Everything to activate, in final order, with at most one entry per slug.
 *
 * Deduplication happens here rather than at activation time on purpose. The
 * slug keys an extension's data dir, secrets, and schedules, so activating two
 * copies of one extension would have them fight over the same state — and the
 * registry's first-wins rule for commands would silently pick the opposite
 * copy from the one that ran its hooks. Resolving to a single winner before
 * anything is imported keeps those decisions consistent.
 *
 * Precedence follows scan order, so the narrowest scope wins: global
 * directories first, then the conversation's, then explicit roots.
 */
function collectExtensions(options: LoadExtensionsOptions): DiscoveredExtension[] {
  const bySlug = new Map<string, DiscoveredExtension>();
  const candidates = [
    ...options.dirs.flatMap(discoverExtensionEntrypoints),
    ...(options.roots ?? []).flatMap(resolveExtensionRoot),
  ];

  for (const candidate of candidates) {
    const shadowed = bySlug.get(candidate.slug);
    if (shadowed && shadowed.rootDir !== candidate.rootDir) {
      log.logInfo(
        `Extension "${candidate.slug}" from ${candidate.rootDir} shadows ${shadowed.rootDir}`,
      );
    }
    bySlug.set(candidate.slug, candidate);
  }
  return [...bySlug.values()];
}

/** Resolve one explicit extension root (directory with an entrypoint, or a bare file). */
function resolveExtensionRoot(rootDir: string): DiscoveredExtension[] {
  let stats;
  try {
    stats = statSync(rootDir);
  } catch {
    log.logWarning(`Extension path does not exist: ${rootDir}`);
    return [];
  }
  if (stats.isFile()) {
    return EXTENSION_FILE_PATTERN.test(basename(rootDir))
      ? [{ entrypoint: rootDir, rootDir, slug: extensionSlug(rootDir) }]
      : [];
  }
  const entrypoint = resolveDirectoryEntrypoint(rootDir);
  if (!entrypoint) {
    log.logWarning(
      `No extension entrypoint in ${rootDir}`,
      "expected an index.{mjs,js,ts,mts} or a package.json with mikan.extensions",
    );
    return [];
  }
  return [{ entrypoint, rootDir, slug: extensionSlug(rootDir) }];
}

/**
 * Validate an extension source path (a directory or a single file) WITHOUT
 * activating it: resolves the entrypoint (package.json `mikan.extensions`,
 * index file, or the file itself), imports it, and checks it exports an
 * `activate` function. Used by `mikan ext install` as a preflight and by
 * `mikan ext validate`. Importing runs top-level module code but not
 * `activate`, so there are no schedule/tool side effects.
 */
export async function validateExtension(sourcePath: string): Promise<ExtensionValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rootDir = sourcePath.replace(/[/\\]+$/, "");
  const base = basename(rootDir);

  if (INDEX_FILE_PATTERN.test(base)) {
    warnings.push(
      "Entry is a bare index file; install into a named directory so the slug is stable.",
    );
  }

  let entrypoint: string | undefined;
  if (!existsSync(rootDir)) {
    errors.push(`Path does not exist: ${rootDir}`);
  } else if (statSync(rootDir).isDirectory()) {
    entrypoint = resolveDirectoryEntrypoint(rootDir);
    if (!entrypoint) {
      errors.push(
        "No entrypoint found: expected package.json with a mikan.extensions entry, or an index.{mjs,js,ts,mts}.",
      );
    }
  } else if (EXTENSION_FILE_PATTERN.test(base)) {
    entrypoint = rootDir;
  } else {
    errors.push(`Not an extension file (expected .mjs/.js/.ts/.mts): ${rootDir}`);
  }

  const slug = extensionSlug(rootDir);
  const manifest = readManifest(rootDir);
  const skillNames = loadExtensionSkills(rootDir, slug).map((skill) => skill.name);

  if (entrypoint) {
    try {
      const moduleExports: unknown = await importExtensionModule(entrypoint);
      if (!resolveActivate(moduleExports)) {
        errors.push("Module does not export an activate function (default or named).");
      }
    } catch (err) {
      errors.push(`Failed to import: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    ok: errors.length === 0,
    slug,
    name: manifest.name ?? slug,
    version: manifest.version,
    description: manifest.description,
    entrypoint,
    skillNames,
    errors,
    warnings,
  };
}
