import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import type { CommandHandler } from "../commands/types.js";
import * as log from "../log.js";

export const MIKAN_EXTENSIONS_DIR = join(homedir(), ".pi", "mikan", "extensions");

export interface MikanExtensionContext {
  log: typeof log;
}

/**
 * Contract for a mikan extension module. Deliberately narrow (v1): extensions
 * contribute additional AgentTools and/or chat CommandHandlers using mikan's
 * existing types, nothing more (no lifecycle hooks, no UI, no direct
 * session/model/filesystem access beyond what a tool implementation already has).
 */
export interface MikanExtensionModule {
  /** Display name, used in load logs and error messages. */
  name: string;
  /** Additional AgentTools contributed by this extension. */
  tools?(ctx: MikanExtensionContext): AgentTool<TSchema>[] | Promise<AgentTool<TSchema>[]>;
  /** Additional chat command handlers, tried after mikan's built-in ones. */
  commands?(ctx: MikanExtensionContext): CommandHandler[] | Promise<CommandHandler[]>;
}

export interface LoadedExtension {
  path: string;
  module: MikanExtensionModule;
}

export interface ExtensionLoadResult {
  extensions: LoadedExtension[];
  errors: Array<{ path: string; error: string }>;
}

export interface CollectedExtensionContributions {
  tools: AgentTool<TSchema>[];
  commands: CommandHandler[];
}

function isMikanExtensionModule(value: unknown): value is MikanExtensionModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function listCandidateFiles(dir: string): string[] {
  const candidates: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      candidates.push(join(dir, entry.name));
      continue;
    }
    if (entry.isDirectory()) {
      const indexPath = join(dir, entry.name, "index.js");
      if (existsSync(indexPath)) candidates.push(indexPath);
    }
  }
  return candidates;
}

/**
 * Discover and import extension modules from `dir` (default `~/.pi/mikan/extensions/`).
 * Flat, non-recursive discovery: `<dir>/*.js` or `<dir>/<name>/index.js`. A missing
 * directory is not an error (extensions are optional). Every import is isolated —
 * one broken extension is recorded as an error and never blocks the rest from loading.
 */
export async function loadMikanExtensions(
  dir: string = MIKAN_EXTENSIONS_DIR,
): Promise<ExtensionLoadResult> {
  const extensions: LoadedExtension[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  if (!existsSync(dir)) return { extensions, errors };

  let candidates: string[];
  try {
    candidates = listCandidateFiles(dir);
  } catch (err) {
    errors.push({ path: dir, error: err instanceof Error ? err.message : String(err) });
    return { extensions, errors };
  }

  for (const path of candidates) {
    try {
      const imported = (await import(pathToFileURL(path).href)) as {
        default?: unknown;
        mikanExtension?: unknown;
      };
      const candidate = imported.default ?? imported.mikanExtension;
      if (!isMikanExtensionModule(candidate)) {
        errors.push({
          path,
          error: "extension is missing a string `name` export (default or `mikanExtension`)",
        });
        continue;
      }
      extensions.push({ path, module: candidate });
    } catch (err) {
      errors.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { extensions, errors };
}

function wrapCommandHandler(extensionName: string, handler: CommandHandler): CommandHandler {
  return {
    async tryHandle(context) {
      try {
        return await handler.tryHandle(context);
      } catch (err) {
        log.logWarning(
          `Extension "${extensionName}" command handler threw`,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    },
  };
}

/** Instantiate every loaded extension's tools/commands, isolating failures per extension. */
export async function collectExtensionContributions(
  result: ExtensionLoadResult,
  ctx: MikanExtensionContext,
): Promise<CollectedExtensionContributions> {
  const tools: AgentTool<TSchema>[] = [];
  const commands: CommandHandler[] = [];

  for (const { path, module } of result.extensions) {
    if (module.tools) {
      try {
        tools.push(...(await module.tools(ctx)));
      } catch (err) {
        log.logWarning(
          `Extension "${module.name}" (${path}) failed to provide tools`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (module.commands) {
      try {
        const handlers = await module.commands(ctx);
        commands.push(...handlers.map((handler) => wrapCommandHandler(module.name, handler)));
      } catch (err) {
        log.logWarning(
          `Extension "${module.name}" (${path}) failed to provide commands`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  return { tools, commands };
}

let cachedContributions: Promise<CollectedExtensionContributions> | undefined;

/**
 * Load and cache mikan's extensions for the lifetime of the process. Extensions
 * are loaded once at first use; changing the extensions directory requires a
 * process restart (no hot-reload in v1).
 */
export function getMikanExtensionContributions(
  dir: string = MIKAN_EXTENSIONS_DIR,
): Promise<CollectedExtensionContributions> {
  if (!cachedContributions) {
    cachedContributions = loadMikanExtensions(dir).then(async (result) => {
      for (const error of result.errors) {
        log.logWarning(`Failed to load extension: ${error.path}`, error.error);
      }
      if (result.extensions.length > 0) {
        log.logInfo(
          `Loaded ${result.extensions.length} extension(s): ${result.extensions.map((e) => e.module.name).join(", ")}`,
        );
      }
      return collectExtensionContributions(result, { log });
    });
  }
  return cachedContributions;
}
