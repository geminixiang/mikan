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
import { existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import * as log from "../../log.js";
import { ExtensionRegistry } from "./registry.js";
import type {
  ExtensionLoadError,
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

export interface LoadExtensionsOptions {
  /** Directories to scan for extensions. Missing directories are skipped. */
  dirs: string[];
  context: {
    conversationId: string;
    workspaceDir: string;
    model: Model<Api>;
    thinkingLevel: ThinkingLevel;
  };
}

export interface LoadExtensionsResult {
  registry: ExtensionRegistry;
  extensions: LoadedExtension[];
  errors: ExtensionLoadError[];
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
        const name = extension.name ?? entrypoint;
        const api: MikanExtensionApi = {
          on: (hook, handler) => registry.register(name, hook, handler),
          registerTool: (tool: AgentTool) => registry.registerTool(tool),
          log: (message: string) => log.logInfo(`[extension:${name}] ${message}`),
          context: options.context,
        };
        await extension.activate(api);
        extensions.push({ name, path: entrypoint });
      } catch (err) {
        errors.push({
          path: entrypoint,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { registry, extensions, errors };
}
