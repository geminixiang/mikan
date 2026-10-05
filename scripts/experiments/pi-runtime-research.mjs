import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, statSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const local = createRequire(new URL("../../package.json", import.meta.url));
const dataset = { parentMessages: 300, forks: 100, childMessages: 40, textBytes: 2048 };
const text = "x".repeat(dataset.textBytes);
const message = (index) => ({ role: "user", content: `${index}:${text}`, timestamp: index });
const rounded = (value) => Math.round(value * 100) / 100;
const elapsed = (start) => rounded(performance.now() - start);
const mib = (bytes) => rounded(bytes / 1024 / 1024);
const gcHeap = () => {
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
};
const bytesAt = (path) =>
  statSync(path).isDirectory()
    ? readdirSync(path).reduce((total, name) => total + bytesAt(join(path, name)), 0)
    : statSync(path).size;

function sdkPackage() {
  const path =
    process.env.PI_CODING_AGENT_PACKAGE ??
    local.resolve("@earendil-works/pi-coding-agent/package.json");
  return { path, metadata: JSON.parse(readFileSync(path, "utf8")) };
}

async function sdk() {
  const { path, metadata } = sdkPackage();
  return import(new URL(metadata.exports["."].import, pathToFileURL(path)).href);
}

async function durable(mode, path) {
  const api = await import("@earendil-works/pi-durable");
  const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const open =
    mode === "jsonl"
      ? (await import("@earendil-works/pi-durable/storage/jsonl/node")).openNodeJsonlStorage
      : (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage;
  return { api, context, createModels, open: () => open(path, context) };
}

async function build(mode, directory) {
  mkdirSync(directory, { recursive: true });
  if (mode === "sdk") {
    const { SessionManager } = await sdk();
    const parent = SessionManager.create(directory, directory);
    for (let i = 0; i < dataset.parentMessages; i++) parent.appendMessage(message(i));
    const parentFile = parent.getSessionFile();
    const cut = parent.getLeafId();
    const start = performance.now();
    for (let i = 0; i < dataset.forks; i++) {
      const child = SessionManager.open(parentFile, directory);
      child.createBranchedSession(cut);
      for (let j = 0; j < dataset.childMessages; j++) child.appendMessage(message(j));
      assert.equal(
        child.buildSessionContext().messages.length,
        dataset.parentMessages + dataset.childMessages,
      );
    }
    assert.equal(parent.buildSessionContext().messages.length, dataset.parentMessages);
    return { forkAndAppendMs: elapsed(start), bytes: bytesAt(directory) };
  }
  const path = mode === "jsonl" ? join(directory, "storage") : join(directory, "sessions.db");
  const { api, context, createModels, open } = await durable(mode, path);
  const harness = await api.Harness.open(
    await open(),
    { models: createModels(), registry: api.createRegistry() },
    context,
  );
  const parent = await harness.root(context);
  let cut;
  await parent.commit(async (tx) => {
    for (let i = 0; i < dataset.parentMessages; i++) {
      cut = (await tx.appendEntry(parent.id, { kind: "pi.user", model: [message(i)] })).id;
    }
  }, context);
  const start = performance.now();
  for (let i = 0; i < dataset.forks; i++) {
    const child = await parent.fork(cut, { ownership: { kind: "ownerless" } }, context);
    await child.commit(async (tx) => {
      for (let j = 0; j < dataset.childMessages; j++) {
        await tx.appendEntry(child.id, { kind: "pi.user", model: [message(j)] });
      }
    }, context);
    assert.equal(
      (await child.context(context)).messages.length,
      dataset.parentMessages + dataset.childMessages,
    );
  }
  assert.equal((await parent.context(context)).messages.length, dataset.parentMessages);
  const forkAndAppendMs = elapsed(start);
  await harness.close(context);
  return { forkAndAppendMs, bytes: bytesAt(directory) };
}

async function measure(mode, directory, all) {
  let handles;
  let close;
  let inspect;
  let open;
  if (mode === "sdk") {
    const { SessionManager } = await sdk();
    const files = readdirSync(directory).filter((name) => name.endsWith(".jsonl"));
    open = async () => {
      handles = (all ? files : files.slice(0, 1)).map((file) =>
        SessionManager.open(join(directory, file), directory),
      );
    };
    inspect = async () => handles.map((handle) => handle.buildSessionContext().messages.length);
  } else {
    const path = mode === "jsonl" ? join(directory, "storage") : join(directory, "sessions.db");
    const { api, context, createModels, open: openStorage } = await durable(mode, path);
    open = async () => {
      handles = await api.Harness.open(
        await openStorage(),
        { models: createModels(), registry: api.createRegistry() },
        context,
      );
    };
    inspect = async () => {
      if (!all) return [(await (await handles.root(context)).context(context)).messages.length];
      const page = await handles.commit((tx) => tx.scanConversations({}, 200), context);
      const counts = [];
      for (const record of page.items)
        counts.push(
          (await (await handles.conversation(record.id, context)).context(context)).messages.length,
        );
      return counts;
    };
    close = async () => handles.close(context);
  }
  const baseline = gcHeap();
  let start = performance.now();
  await open();
  const openMs = elapsed(start);
  const openHeapMiB = mib(gcHeap() - baseline);
  start = performance.now();
  const counts = await inspect();
  const contextMs = elapsed(start);
  assert.ok(
    counts.every(
      (n) => n === dataset.parentMessages || n === dataset.parentMessages + dataset.childMessages,
    ),
  );
  assert.equal(counts.length, all ? dataset.forks + 1 : 1);
  if (!all) assert.equal(counts[0], dataset.parentMessages);
  const contextHeapMiB = mib(gcHeap() - baseline);
  await close?.();
  return { openMs, openHeapMiB, contextMs, contextHeapMiB, conversationsRead: counts.length };
}

async function headless(directory) {
  const api = await sdk();
  const aiPackage = join(
    dirname(sdkPackage().path),
    "node_modules",
    "@earendil-works",
    "pi-ai",
    "package.json",
  );
  const aiMetadata = JSON.parse(readFileSync(aiPackage, "utf8"));
  const ai = await import(new URL(aiMetadata.exports["."].import, pathToFileURL(aiPackage)).href);
  const config = {
    id: "offline",
    name: "Offline",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
  const runtime = await api.ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  let calls = 0;
  const sessionIds = [];
  runtime.registerProvider("research", {
    api: "openai-responses",
    baseUrl: "https://example.invalid",
    apiKey: "offline-placeholder",
    models: [config],
    streamSimple: (model, request, options) => {
      calls += 1;
      if (calls === 2) {
        assert.ok(
          request.messages.some(
            (entry) =>
              entry.role === "toolResult" &&
              entry.content.some(
                (part) => part.type === "text" && part.text.includes("virtual sandbox data"),
              ),
          ),
        );
      }
      sessionIds.push(options.sessionId);
      const stream = ai.createAssistantMessageEventStream();
      const response = {
        role: "assistant",
        content:
          calls === 1
            ? [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "fixture.txt" } }]
            : [{ type: "text", text: "offline answer" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: calls === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason: response.stopReason, message: response });
        stream.end(response);
      });
      return stream;
    },
  });
  let reads = 0;
  const read = api.createReadToolDefinition(directory, {
    operations: {
      access: async () => {},
      readFile: async () => {
        reads += 1;
        return Buffer.from("virtual sandbox data");
      },
    },
  });
  const loader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: api.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Offline research fixture",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await api.createAgentSession({
    cwd: directory,
    agentDir: directory,
    model: runtime.getModel("research", "offline"),
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: api.SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    }),
    sessionManager: api.SessionManager.inMemory(directory),
    tools: ["read"],
    customTools: [read],
  });
  try {
    await session.prompt("Read the virtual fixture.");
    assert.equal(reads, 1);
    assert.equal(calls, 2);
    assert.ok(sessionIds.every((id) => id === session.sessionId));
    assert.equal(session.getLastAssistantText(), "offline answer");
    return {
      headless: true,
      injectedReadOperations: true,
      requests: calls,
      stableSessionId: true,
      answer: session.getLastAssistantText(),
    };
  } finally {
    session.dispose();
  }
}

const [operation, mode, directory, scope] = process.argv.slice(2);
if (operation) {
  const result =
    operation === "build"
      ? await build(mode, directory)
      : operation === "measure"
        ? await measure(mode, directory, scope === "all")
        : await headless(directory);
  console.log(JSON.stringify(result));
} else {
  const base = mkdtempSync(join(tmpdir(), "mikan-pi-storage-poc-"));
  const script = fileURLToPath(import.meta.url);
  const run = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, ["--expose-gc", script, ...args], {
        encoding: "utf8",
        timeout: 120000,
      }),
    );
  try {
    const durablePackage = join(
      dirname(dirname(local.resolve("@earendil-works/pi-durable"))),
      "package.json",
    );
    const result = {
      node: process.version,
      dataset,
      versions: {
        durable: JSON.parse(readFileSync(durablePackage, "utf8")).version,
        codingAgent: sdkPackage().metadata.version,
      },
      modes: {},
    };
    for (const backend of ["sdk", "jsonl", "sqlite"]) {
      const dir = join(base, backend);
      const built = run("build", backend, dir);
      result.modes[backend] = { ...built, one: [], all: [] };
      for (let i = 0; i < 3; i++) {
        result.modes[backend].one.push(run("measure", backend, dir, "one"));
        result.modes[backend].all.push(run("measure", backend, dir, "all"));
      }
    }
    mkdirSync(join(base, "headless"));
    result.sdk = run("headless", "sdk", join(base, "headless"));
    console.log(JSON.stringify(result, null, 2));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
