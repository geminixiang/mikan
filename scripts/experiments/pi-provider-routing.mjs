import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, ProviderDoc, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const directory = mkdtempSync(join(tmpdir(), "mikan-native-routing-"));
const path = join(directory, "sessions.db");
const models = createModels();
const bindings = new Map();
const seen = [];
const routed = new Proxy(models, {
  get(target, key) {
    if (key === "streamSimple" || key === "completeSimple") {
      return (model, request, options) => {
        const binding = [...bindings.values()].find(
          (item) => item.sessionId === options?.sessionId,
        );
        assert.ok(binding, "request must have an active native identity binding");
        seen.push({ owner: binding.owner, method: key, sessionId: options.sessionId });
        return binding.models[key](model, structuredClone(request), options);
      };
    }
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
let harness;
try {
  harness = await Harness.open(
    await openNodeSqliteStorage(path),
    {
      models: routed,
      registry: createRegistry(),
      settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    },
    context,
  );
  const parent = await harness.root(context);
  const at = await parent.commit(
    async (tx) =>
      (
        await tx.appendEntry(parent.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "parent history", timestamp: 0 }],
        })
      ).id,
    context,
  );
  const child = await parent.fork(at, { ownership: { kind: "ownerless" } }, context);
  const reference = fauxProvider().getModel();
  for (const [owner, conversation] of [
    ["parent", parent],
    ["child", child],
  ]) {
    const faux = fauxProvider();
    const catalog = createModels();
    catalog.setProvider(faux.provider);
    models.setProvider(faux.provider);
    faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage(`${owner} answer`)));
    await conversation.configure(
      { model: { provider: reference.provider, modelId: reference.id } },
      context,
    );
    const sessionId = await conversation.commit(
      async (tx) => (await tx.doc(ProviderDoc, conversation.id)).sessionId,
      context,
    );
    bindings.set(conversation.id, { owner, sessionId, models: catalog });
  }
  assert.notEqual(bindings.get(parent.id).sessionId, bindings.get(child.id).sessionId);
  const submissions = await Promise.all([
    parent.submit({ type: "input", content: "parent" }, context),
    child.submit({ type: "input", content: "child" }, context),
  ]);
  await Promise.all(submissions.map((submission) => submission.wait(context)));
  await (await child.submit({ type: "input", content: "child follow-up" }, context)).wait(context);
  const compact = await child.compact(undefined, context);
  const receipt = await harness.waitForTask(compact, context);
  assert.equal(receipt.state.outcome.status, "completed");
  assert.ok(
    seen.some((request) => request.owner === "child" && request.method === "completeSimple"),
  );
  assert.ok(
    seen.some((request) => request.owner === "parent" && request.method === "streamSimple"),
  );
  await parent.reset(undefined, context);
  assert.equal(
    (await harness.snapshot(ProviderDoc, parent.id, context)).sessionId,
    bindings.get(parent.id).sessionId,
  );
  await harness.close(context);
  harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models: routed, registry: createRegistry() },
    context,
  );
  for (const [id, binding] of bindings)
    assert.equal((await harness.snapshot(ProviderDoc, id, context)).sessionId, binding.sessionId);

  const messages = Array.from({ length: 340 }, () => ({ role: "user", content: "fixture" }));
  const owners = new WeakMap();
  const active = new Map(
    Array.from({ length: 12 }, (_, index) => [index, { sessionId: `fixture-${index}` }]),
  );
  const iterations = 100000;
  let start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const last = { ...messages.at(-1) };
    owners.set(last, 1);
    const tagged = [...messages.slice(0, -1), last];
    assert.equal(owners.get(tagged.at(-1)), 1);
  }
  const objectRoutingMs = performance.now() - start;
  start = performance.now();
  for (let i = 0; i < iterations; i++)
    assert.ok([...active.values()].find((binding) => binding.sessionId === "fixture-11"));
  console.log(
    JSON.stringify(
      {
        seen,
        persistedIdentity: true,
        distinctForkIdentity: true,
        resetKeepsIdentity: true,
        clonedRequestContext: true,
        iterations,
        objectRoutingMs,
        nativeLookupMs: performance.now() - start,
      },
      null,
      2,
    ),
  );
} finally {
  await harness?.close(context);
  rmSync(directory, { recursive: true, force: true });
}
