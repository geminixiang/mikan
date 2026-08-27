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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  createConversationEvent,
  createConversationMessage,
  createConversationRuntime,
  type ConversationContext,
  type ConversationResponder,
  type MessagingBot,
  type MessagingInfo,
} from "../index.js";
import { updateConversationSettings } from "../config.js";
import { formatSource, parseSource } from "../packages/index.js";
import { createOfficeAddress, createWorkspace } from "../office/index.js";
import type { Workspace } from "../office/types.js";
import { basename, join, resolve } from "node:path";
import {
  defaultExtensionDirs,
  listInstalledExtensions,
  validateExtension,
} from "../harness/index.js";
import { resolveStateDir, takeValueFlag } from "./arg-grammar.js";
import { isGitSourceString, materializeSource } from "../packages/index.js";
import { officeStateDir } from "../office/index.js";
import { resolveOwnedOfficeAddress } from "../office/index.js";

interface ExtArgs {
  action?: string;
  target?: string;
  stateDir: string;
  scope: "global" | "conversation" | undefined;
  conversationId?: string;
  /** Workspace root; lets `remove --purge` sweep the events bus. */
  workspaceDir?: string;
  /** With `remove`: also sweep schedules, secrets, and data for the slug. */
  purge: boolean;
}

function parseExtArgs(argv: string[]): ExtArgs {
  // Shares the daemon's state-dir precedence: --state-dir > env > ~/.mikan.
  const stateDir = resolveStateDir(argv);
  let scope: ExtArgs["scope"];
  let conversationId: string | undefined;
  let workspaceDir: string | undefined;
  let purge = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let taken;
    if (arg === "--global") scope = "global";
    else if (arg === "--purge") purge = true;
    else if ((taken = takeValueFlag(argv, i, "--conversation"))) {
      scope = "conversation";
      conversationId = taken.value || undefined;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(argv, i, "--workspace"))) {
      workspaceDir = taken.value ? resolve(taken.value) : undefined;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(argv, i, "--state-dir"))) {
      i = taken.lastIndex; // value already folded in by resolveStateDir
    } else positional.push(arg);
  }

  return {
    action: positional[0] ?? "",
    target: positional[1],
    stateDir,
    scope,
    conversationId,
    workspaceDir,
    purge,
  };
}

/** Directory that extension CODE for the chosen scope lives in. */
function scopeExtensionsDir(args: ExtArgs): string {
  if (args.scope === "global") return join(args.stateDir, "global", "extensions");
  if (args.scope === "conversation" && args.conversationId) {
    // defaultExtensionDirs returns [global, conversation]; take the conversation one.
    const conversationDir = defaultExtensionDirs(
      resolveOwnedOfficeAddress(args.conversationId, args.stateDir),
      args.stateDir,
    )[1];
    if (conversationDir === undefined) {
      throw new Error("defaultExtensionDirs returned no conversation directory");
    }
    return conversationDir;
  }
  throw new Error("Specify a scope: --global or --conversation <id>");
}

const USAGE = `Usage:
  mikan ext dev <path> [--workspace <dir>] [--state-dir <dir>]
      Run an extension in a local stdin/stdout conversation — no Slack, no
      install. Edit, send /pi-new, test again.
  mikan ext install <source> (--global | --conversation <id>) [--state-dir <dir>]
      <source>: a local path, or a git URL / github:owner/repo with optional @ref and #subpath
      e.g. github:geminixiang/mikan#deploy/examples/extensions/agent-pm
      Reinstalling over an existing extension updates it (data preserved).
  mikan ext validate <path>
  mikan ext list [--conversation <id>] [--state-dir <dir>]
  mikan ext remove <slug> (--global | --conversation <id>) [--purge] [--workspace <dir>] [--state-dir <dir>]
      Removes the extension's code. --purge also sweeps its schedules, secrets
      vault, and data dirs; add --workspace to sweep its event files too.`;

export async function runExtCommand(argv: string[]): Promise<number> {
  const args = parseExtArgs(argv);

  switch (args.action) {
    case "dev":
      // Parsed by the dev command itself: it takes different flags.
      return runExtDevCommand(argv.slice(1));
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

  // Resolve the source: a git source materializes through the packages layer
  // (cached clone under the scope's git/ dir, @ref supported); a local path is
  // used directly. `refresh` re-fetches so reinstall always picks up updates.
  let source: string;
  if (isGitSourceString(args.target)) {
    try {
      source = materializeSource(args.target, {
        scope: args.scope!,
        address:
          args.scope === "conversation"
            ? resolveOwnedOfficeAddress(args.conversationId!, args.stateDir)
            : undefined,
        stateDir: args.stateDir,
        mode: "refresh",
      }).dir;
    } catch (err) {
      console.error(`Failed to fetch ${args.target}: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
  } else {
    source = resolve(args.target);
  }

  return await installResolved(args, source, destDir);
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
      : join(
          officeStateDir(
            args.stateDir,
            resolveOwnedOfficeAddress(args.conversationId!, args.stateDir),
          ),
          "extension-data",
          result.slug,
        );
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
    ? defaultExtensionDirs(
        resolveOwnedOfficeAddress(args.conversationId, args.stateDir),
        args.stateDir,
      )
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
    if (info.secrets.length > 0) {
      const keys = info.secrets.map((s) => `${s.key}${s.required ? " (required)" : ""}`);
      console.log(`  secrets: ${keys.join(", ")}`);
    }
  }
  return 0;
}

/**
 * Everything a slug leaves behind outside its code dir: callback-schedule
 * files, the secrets vault, data dirs, and (when the workspace is known)
 * `ext.<slug>.*` / `extrun.<slug>.*` files on the events bus.
 */
interface ExtensionResidue {
  callbackScheduleFiles: string[];
  vaultDir?: string;
  dataDirs: string[];
  eventFiles: string[];
}

/** Files in `dir` (non-recursive) whose names satisfy `matches`; [] when absent. */
function matchingFiles(dir: string, matches: (filename: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(matches)
    .map((filename) => join(dir, filename));
}

function findExtensionResidue(
  slug: string,
  stateDir: string,
  workspaceDir?: string,
): ExtensionResidue {
  const callbackScheduleFiles: string[] = [];
  const dataDirs: string[] = [];
  const conversationsDir = join(stateDir, "conversations");
  const officeDirs = existsSync(conversationsDir) ? readdirSync(conversationsDir) : [];
  for (const officeDir of officeDirs) {
    callbackScheduleFiles.push(
      ...matchingFiles(
        join(conversationsDir, officeDir, "extension-schedules"),
        (filename) => filename.startsWith(`${slug}.`) && filename.endsWith(".json"),
      ),
    );
    const dataDir = join(conversationsDir, officeDir, "extension-data", slug);
    if (existsSync(dataDir)) dataDirs.push(dataDir);
  }
  const globalDataDir = join(stateDir, "global", "extension-data", slug);
  if (existsSync(globalDataDir)) dataDirs.push(globalDataDir);

  const eventFiles = workspaceDir
    ? matchingFiles(
        join(workspaceDir, "events"),
        (filename) =>
          (filename.startsWith(`ext.${slug}.`) || filename.startsWith(`extrun.${slug}.`)) &&
          filename.endsWith(".json"),
      )
    : [];

  const vaultDir = join(stateDir, "vaults", "extensions", slug);
  return {
    callbackScheduleFiles,
    ...(existsSync(vaultDir) ? { vaultDir } : {}),
    dataDirs,
    eventFiles,
  };
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
  console.log(`Removed ${match.name} (slug: ${match.slug}).`);

  // Never sweep implicitly: the same slug may still be active through another
  // scope or a PACKAGES declaration this command cannot see. --purge is the
  // admin's statement that nothing else owns it.
  const residue = findExtensionResidue(match.slug, args.stateDir, args.workspaceDir);
  if (args.purge) {
    for (const file of [...residue.callbackScheduleFiles, ...residue.eventFiles]) {
      rmSync(file, { force: true });
    }
    for (const dataDir of residue.dataDirs) rmSync(dataDir, { recursive: true, force: true });
    if (residue.vaultDir) rmSync(residue.vaultDir, { recursive: true, force: true });
    console.log(
      `Purged: ${residue.callbackScheduleFiles.length} schedule file(s), ` +
        `${residue.eventFiles.length} event file(s), ${residue.dataDirs.length} data dir(s)` +
        `${residue.vaultDir ? ", secrets vault" : ""}.`,
    );
    if (!args.workspaceDir) {
      console.log(
        "Note: events-bus files were not swept — pass --workspace <dir> to include them.",
      );
    }
    if (residue.callbackScheduleFiles.length > 0) {
      console.log("A running daemon keeps deleted schedules armed until restart.");
    }
  } else {
    const leftovers = [
      residue.callbackScheduleFiles.length > 0
        ? `${residue.callbackScheduleFiles.length} schedule file(s)`
        : undefined,
      residue.vaultDir ? "secrets vault" : undefined,
      residue.dataDirs.length > 0 ? `${residue.dataDirs.length} data dir(s)` : undefined,
      residue.eventFiles.length > 0 ? `${residue.eventFiles.length} event file(s)` : undefined,
    ].filter(Boolean);
    if (leftovers.length > 0) {
      console.log(`Left in place: ${leftovers.join(", ")}. Re-run with --purge to sweep.`);
    }
  }
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
  secrets: Array<{ key: string; required?: boolean }>;
  errors: string[];
  warnings: string[];
}): void {
  console.log(`${result.name}${result.version ? `@${result.version}` : ""} (slug: ${result.slug})`);
  if (result.entrypoint) console.log(`  entrypoint: ${result.entrypoint}`);
  if (result.skillNames.length > 0) console.log(`  skills: ${result.skillNames.join(", ")}`);
  if (result.secrets.length > 0) {
    const keys = result.secrets.map((s) => `${s.key}${s.required ? " (required)" : ""}`);
    console.log(`  secrets: ${keys.join(", ")}`);
  }
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  for (const error of result.errors) console.error(`  error: ${error}`);
  console.log(result.ok ? "  ✓ valid" : "  ✗ invalid");
}

// ── ext dev (interactive extension dev loop) ────────────────────────────────

/**
 * `mikan ext dev <path>` — develop an extension without a Slack workspace.
 *
 *   mikan ext dev ./my-extension
 *   > add a poll for lunch
 *   [agent reply]
 *   > /pi-new          # picks up your edits
 *
 * The alternative this exists to avoid is asking every extension author to
 * install mikan into a real Slack workspace, create an app, and deploy before
 * they can see whether their `activate()` even runs.
 *
 * It is a stdin/stdout conversation on the same runtime production uses — same
 * package resolution, same loader, same commands — with the platform swapped
 * for the terminal and the sandbox set to `host`. That equivalence is the
 * point: an extension that works here works in a channel, because nothing
 * about how it is found or activated differs.
 *
 * The working copy is registered as a conversation-scoped local package, which
 * is by-reference rather than copied, so the edit → `/pi-new` → test loop needs
 * no reinstall step.
 */
const DEV_USAGE = `Usage:
  mikan ext dev <path|source> [--workspace <dir>] [--state-dir <dir>]

  <path>       a working copy of an extension (or a package directory)
  --workspace  where conversation state is written (default: ./.mikan-ext-dev)

  Type a message to run the agent against your extension. /pi-new reloads it
  after an edit; Ctrl-D exits.`;

/**
 * One dev conversation per extension, so two extensions can be developed side
 * by side without overwriting each other's settings or session history.
 */
function devConversationId(source: string): string {
  const name = basename(source.replace(/[#@].*$/, "").replace(/\/+$/, "")) || "extension";
  return `ext-dev-${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`.slice(0, 64);
}

async function runExtDevCommand(argv: string[]): Promise<number> {
  const stateDir = resolveStateDir(argv);
  let workspaceDir: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    let taken;
    if ((taken = takeValueFlag(argv, i, "--workspace"))) {
      workspaceDir = taken.value;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(argv, i, "--state-dir"))) {
      i = taken.lastIndex; // already folded in by resolveStateDir
    } else positional.push(arg);
  }

  const target = positional[0];
  if (!target) {
    console.error(DEV_USAGE);
    return 1;
  }

  // A local working copy is the common case; resolve it to an absolute path so
  // the stored package source does not depend on the shell's cwd.
  let source: string;
  try {
    const parsed = parseSource(
      existsSync(target) && !target.startsWith(".") ? resolvePath(target) : target,
    );
    source = formatSource(parsed);
    if (parsed.type === "local" && !statSync(parsed.path).isDirectory()) {
      console.error(`Not a directory: ${parsed.path}`);
      return 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const conversationId = devConversationId(target);
  const workingDir = resolvePath(workspaceDir ?? join(process.cwd(), ".mikan-ext-dev"));

  // Declaring the working copy as this conversation's package is what makes
  // the dev loop use the real resolution path rather than a bespoke one.
  process.env.MIKAN_STATE_DIR = stateDir;
  const workspace = createWorkspace({ root: workingDir, stateDir });
  const devOffice = workspace.office(createOfficeAddress("slack", conversationId));
  devOffice.ensure();
  updateConversationSettings(devOffice, { packages: [source] });

  console.log(`mikan ext dev — ${source}`);
  console.log(`  conversation: ${conversationId}`);
  console.log(`  workspace:    ${workingDir}`);
  console.log(`  state dir:    ${stateDir}`);
  console.log("Type a message. /pi-new reloads after an edit. Ctrl-D exits.\n");

  return runDevLoop({ conversationId, workspace });
}

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

function runDevLoop(options: { conversationId: string; workspace: Workspace }): Promise<number> {
  const { conversationId, workspace } = options;

  const platform: MessagingInfo = {
    name: "ext-dev",
    formattingGuide: "Reply in plain text.",
    channels: [{ id: conversationId, name: conversationId }],
    users: [{ id: "dev", userName: "dev", displayName: "Developer" }],
  };

  const runtime = createConversationRuntime({
    workspace,
    // The host executor keeps the loop dependency-free: no Docker, no image
    // pull, no VM. An extension's own tools and hooks do not observe the
    // difference, and the ones that shell out see the developer's machine —
    // which is what they want while iterating.
    sandbox: { type: "host" },
  });

  const bot: MessagingBot = {
    start: async () => {},
    postMessage: async (_conversationId, text) => {
      write(text);
      return `${Date.now()}`;
    },
    updateMessage: async (_conversationId, _ts, text) => write(text),
    enqueueEvent: () => false,
    getMessagingInfo: () => platform,
  };

  const responder: ConversationResponder = {
    respond: async (text) => write(text),
    replaceResponse: async (text) => write(text),
    respondDiagnostic: async (text) => write(`· ${text}`),
    respondToolResult: async (result) => write(`· [${result.toolName}]`),
    setTyping: async () => {},
    setWorking: async () => {},
    uploadFile: async (filePath) => write(`· [file] ${filePath}`),
    deleteResponse: async () => {},
  };

  let counter = 0;
  const handleLine = async (line: string): Promise<void> => {
    const ts = `${++counter}`;
    const event = createConversationEvent({
      platform: "slack",
      type: "message",
      conversationId,
      conversationKind: "direct",
      ts,
      user: "dev",
      text: line,
      sessionKey: conversationId,
    });
    const message = createConversationMessage({
      platform: "slack",
      conversationId,
      id: ts,
      sessionKey: conversationId,
      conversationKind: "direct",
      userId: "dev",
      userName: "Developer",
      text: line,
    });
    const context: ConversationContext = {
      address: event.address,
      message,
      responder,
      platform,
    };
    await runtime.handleEvent(event, bot, context);
  };

  return new Promise<number>((resolveLoop) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
    rl.prompt();
    rl.on("line", (line) => {
      if (!line.trim()) return rl.prompt();
      void handleLine(line)
        .catch((err: unknown) => write(`· error: ${err instanceof Error ? err.message : err}`))
        .finally(() => rl.prompt());
    });
    rl.on("close", () => {
      void runtime.shutdown().then(() => resolveLoop(0));
    });
  });
}
