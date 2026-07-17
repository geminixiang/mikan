/**
 * `mikan ext` — manage extensions from the CLI.
 *
 *   mikan ext install <source> [--global | --conversation <id>] [--state-dir <dir>]
 *   mikan ext validate <path>
 *   mikan ext list [--conversation <id>] [--state-dir <dir>]
 *   mikan ext remove <slug> (--global | --conversation <id>) [--state-dir <dir>]
 *
 * `<source>` is a local path or a git URL (https://…, git@…, or github:owner/repo)
 * with an optional `#subpath` for extensions inside a repo. Reinstalling over an
 * existing extension updates it (data is preserved). Extensions install into the
 * host-only state dir (never the workspace); see src/harness/extensions/LAYOUT.md.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  defaultExtensionDirs,
  listInstalledExtensions,
  validateExtension,
} from "../harness/index.js";
import { resolveStateDir, takeValueFlag } from "./arg-grammar.js";
import { parseGitSource, resolveGitSource } from "./ext-git.js";

interface ExtArgs {
  action?: string;
  target?: string;
  stateDir: string;
  scope: "global" | "conversation" | undefined;
  conversationId?: string;
}

function parseExtArgs(argv: string[]): ExtArgs {
  // Shares the daemon's state-dir precedence: --state-dir > env > ~/.mikan.
  const stateDir = resolveStateDir(argv);
  let scope: ExtArgs["scope"];
  let conversationId: string | undefined;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let taken;
    if (arg === "--global") scope = "global";
    else if ((taken = takeValueFlag(argv, i, "--conversation"))) {
      scope = "conversation";
      conversationId = taken.value || undefined;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(argv, i, "--state-dir"))) {
      i = taken.lastIndex; // value already folded in by resolveStateDir
    } else positional.push(arg);
  }

  return { action: positional[0], target: positional[1], stateDir, scope, conversationId };
}

/** Directory that extension CODE for the chosen scope lives in. */
function scopeExtensionsDir(args: ExtArgs): string {
  if (args.scope === "global") return join(args.stateDir, "global", "extensions");
  if (args.scope === "conversation" && args.conversationId) {
    // defaultExtensionDirs returns [global, conversation]; take the conversation one.
    return defaultExtensionDirs(args.conversationId, args.stateDir)[1];
  }
  throw new Error("Specify a scope: --global or --conversation <id>");
}

const USAGE = `Usage:
  mikan ext install <source> (--global | --conversation <id>) [--state-dir <dir>]
      <source>: a local path, or a git URL / github:owner/repo with optional #subpath
      e.g. github:geminixiang/mikan#examples/extensions/agent-pm
      Reinstalling over an existing extension updates it (data preserved).
  mikan ext validate <path>
  mikan ext list [--conversation <id>] [--state-dir <dir>]
  mikan ext remove <slug> (--global | --conversation <id>) [--state-dir <dir>]`;

function noop(): void {}

export async function runExtCommand(argv: string[]): Promise<number> {
  const args = parseExtArgs(argv);

  switch (args.action) {
    case "validate":
      return validateAction(args);
    case "install":
      return installAction(args);
    case "list":
      return listAction(args);
    case "remove":
      return removeAction(args);
    default:
      console.error(USAGE);
      return 1;
  }
}

async function validateAction(args: ExtArgs): Promise<number> {
  if (!args.target) {
    console.error("ext validate: missing <path>");
    return 1;
  }
  const result = await validateExtension(resolve(args.target));
  printValidation(result);
  return result.ok ? 0 : 1;
}

async function installAction(args: ExtArgs): Promise<number> {
  if (!args.target) {
    console.error("ext install: missing <path>");
    return 1;
  }
  let destDir: string;
  try {
    destDir = scopeExtensionsDir(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Resolve the source: a git URL (optionally with #subpath) is cloned to a
  // temp dir; a local path is used directly.
  const gitSpec = parseGitSource(args.target);
  let source: string;
  let cleanup = noop;
  if (gitSpec) {
    try {
      const resolved = resolveGitSource(gitSpec);
      source = resolved.dir;
      cleanup = resolved.cleanup;
    } catch (err) {
      console.error(`Failed to fetch ${gitSpec.url}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  } else {
    source = resolve(args.target);
  }

  try {
    return await installResolved(args, source, destDir);
  } finally {
    cleanup();
  }
}

async function installResolved(args: ExtArgs, source: string, destDir: string): Promise<number> {
  const result = await validateExtension(source);
  printValidation(result);
  if (!result.ok) {
    console.error("Refusing to install: fix the errors above.");
    return 1;
  }

  // Install into a named subdirectory so the slug never degenerates to the
  // scope name. A bare file installs as <name>.<ext>; a directory as <name>/.
  const destName = basename(source);
  const dest = join(destDir, destName);
  mkdirSync(destDir, { recursive: true });
  // Reinstalling over an existing install is how updates work: replace it.
  const replaced = existsSync(dest);
  if (replaced) rmSync(dest, { recursive: true, force: true });
  cpSync(source, dest, { recursive: true });

  const scopeLabel =
    args.scope === "global" ? "all conversations" : `conversation ${args.conversationId}`;
  const dataDir =
    args.scope === "global"
      ? join(args.stateDir, "global", "extension-data", result.slug)
      : join(args.stateDir, "conversations", args.conversationId!, "extension-data", result.slug);
  const verb = replaced ? "Reinstalled" : "Installed";
  console.log(`\n${verb} ${result.name} (slug: ${result.slug}) for ${scopeLabel}.`);
  console.log(`  code: ${dest}`);
  console.log(`  data: ${dataDir} (created on first use, preserved on reinstall)`);
  console.log("Run /pi-new in the conversation to activate.");
  return 0;
}

function listAction(args: ExtArgs): number {
  // List the requested scope, or both when no conversation is given.
  const dirs = args.conversationId
    ? defaultExtensionDirs(args.conversationId, args.stateDir)
    : [join(args.stateDir, "global", "extensions")];
  const installed = listInstalledExtensions(dirs);
  if (installed.length === 0) {
    console.log("No extensions installed.");
    return 0;
  }
  for (const info of installed) {
    const scope = basename(resolve(info.dir, "..")) === "global" ? "global" : "conversation";
    const version = info.version ? `@${info.version}` : "";
    console.log(`${info.name}${version}  [${scope}]  slug=${info.slug}`);
    if (info.description) console.log(`  ${info.description}`);
    if (info.skillNames.length > 0) console.log(`  skills: ${info.skillNames.join(", ")}`);
  }
  return 0;
}

function removeAction(args: ExtArgs): number {
  if (!args.target) {
    console.error("ext remove: missing <slug>");
    return 1;
  }
  let destDir: string;
  try {
    destDir = scopeExtensionsDir(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // Match by installed slug so the caller doesn't need the exact dir name.
  const match = listInstalledExtensions([destDir]).find((info) => info.slug === args.target);
  if (!match) {
    console.error(`No extension with slug '${args.target}' in ${destDir}`);
    return 1;
  }
  // match.path is the entrypoint. Dir-form: its parent is the extension dir to
  // remove. Bare-file: the parent is the scan dir, so remove the file itself.
  const parent = resolve(match.path, "..");
  const removeTarget = parent === resolve(destDir) ? match.path : parent;
  rmSync(removeTarget, { recursive: true, force: true });
  console.log(`Removed ${match.name} (slug: ${match.slug}). Data left in place.`);
  console.log("Run /pi-new in the conversation to apply.");
  return 0;
}

function printValidation(result: {
  ok: boolean;
  name: string;
  slug: string;
  version?: string;
  entrypoint?: string;
  skillNames: string[];
  errors: string[];
  warnings: string[];
}): void {
  console.log(`${result.name}${result.version ? `@${result.version}` : ""} (slug: ${result.slug})`);
  if (result.entrypoint) console.log(`  entrypoint: ${result.entrypoint}`);
  if (result.skillNames.length > 0) console.log(`  skills: ${result.skillNames.join(", ")}`);
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  for (const error of result.errors) console.error(`  error: ${error}`);
  console.log(result.ok ? "  ✓ valid" : "  ✗ invalid");
}
