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
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { join } from "node:path";
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
import { resolveStateDir, takeValueFlag } from "./arg-grammar.js";
import { conversationOfficeDir, createOfficeAddress } from "../office-address.js";

const USAGE = `Usage:
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

export async function runExtDevCommand(argv: string[]): Promise<number> {
  const stateDir = resolveStateDir(argv);
  let workspaceDir: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let taken;
    if ((taken = takeValueFlag(argv, i, "--workspace"))) {
      workspaceDir = taken.value;
      i = taken.lastIndex;
    } else if ((taken = takeValueFlag(argv, i, "--state-dir"))) {
      i = taken.lastIndex; // already folded in by resolveStateDir
    } else positional.push(argv[i]);
  }

  const target = positional[0];
  if (!target) {
    console.error(USAGE);
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
  mkdirSync(conversationOfficeDir(workingDir, createOfficeAddress("slack", conversationId)), {
    recursive: true,
  });

  // Declaring the working copy as this conversation's package is what makes
  // the dev loop use the real resolution path rather than a bespoke one.
  process.env.MIKAN_STATE_DIR = stateDir;
  updateConversationSettings(
    {
      conversationId,
      conversationDir: conversationOfficeDir(
        workingDir,
        createOfficeAddress("slack", conversationId),
      ),
    },
    { packages: [source] },
  );

  console.log(`mikan ext dev — ${source}`);
  console.log(`  conversation: ${conversationId}`);
  console.log(`  workspace:    ${workingDir}`);
  console.log(`  state dir:    ${stateDir}`);
  console.log("Type a message. /pi-new reloads after an edit. Ctrl-D exits.\n");

  return runDevLoop({ conversationId, workingDir });
}

function write(text: string): void {
  process.stdout.write(`${text}\n`);
}

function runDevLoop(options: { conversationId: string; workingDir: string }): Promise<number> {
  const { conversationId, workingDir } = options;

  const platform: MessagingInfo = {
    name: "ext-dev",
    formattingGuide: "Reply in plain text.",
    channels: [{ id: conversationId, name: conversationId }],
    users: [{ id: "dev", userName: "dev", displayName: "Developer" }],
  };

  const runtime = createConversationRuntime({
    workingDir,
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
