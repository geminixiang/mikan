#!/usr/bin/env node
/**
 * THROWAWAY RESEARCH HARNESS — not production code.
 *
 * Models three workspace projection strategies without requiring Docker or root:
 * 1. direct: the current fixed bind-mount list, represented by host-backed paths;
 * 2. copy: the same list copied into a staging directory;
 * 3. manifest: a host-backed per-file policy manifest that rejects symlinks.
 */
import assert from "node:assert/strict";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONVERSATION = "conversation-a";
const SAMPLE_COUNT = 15;
const FIXTURE_FILE_COUNT = 600;
const READS_PER_SAMPLE = 200;
const STRATEGIES = ["direct", "copy", "manifest"];

function validateConversationId(value) {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error("Conversation id must be a safe path segment");
  }
}

function validateProjectedPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/")) {
    throw new Error("Projected path must be a non-empty relative path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Projected path contains traversal or ambiguous segments");
  }
  return segments.join("/");
}

function selectedRoots(workspace, conversationId) {
  validateConversationId(conversationId);
  return [
    ["MEMORY.md", join(workspace, "MEMORY.md")],
    ["skills", join(workspace, "skills")],
    ["events", join(workspace, "events")],
    [conversationId, join(workspace, conversationId)],
  ];
}

function makeFixture(fileCount = FIXTURE_FILE_COUNT) {
  const fixture = mkdtempSync(join(tmpdir(), "mikan-projection-research-"));
  const workspace = join(fixture, "workspace");
  mkdirSync(join(workspace, "skills"), { recursive: true });
  mkdirSync(join(workspace, "events"), { recursive: true });
  mkdirSync(join(workspace, CONVERSATION, "data"), { recursive: true });
  mkdirSync(join(workspace, "conversation-b"), { recursive: true });
  writeFileSync(join(workspace, "MEMORY.md"), "shared-memory-v1\n");
  writeFileSync(join(workspace, "skills", "guide.md"), "skill-guide\n");
  writeFileSync(join(workspace, "events", "event.json"), '{"event":1}\n');
  writeFileSync(join(workspace, CONVERSATION, "note.txt"), "conversation-a-v1\n");
  writeFileSync(join(workspace, "conversation-b", "private.txt"), "conversation-b-secret\n");
  writeFileSync(join(workspace, "host-only.txt"), "host-only-secret\n");
  const outsideSecret = join(fixture, "outside-secret.txt");
  writeFileSync(outsideSecret, "outside-secret\n");
  symlinkSync(outsideSecret, join(workspace, CONVERSATION, "escape-link"));
  symlinkSync(join(fixture, "does-not-exist"), join(workspace, CONVERSATION, "broken-link"));
  symlinkSync(join(workspace, "MEMORY.md"), join(workspace, "skills", "memory-link"));

  for (let index = 0; index < fileCount; index += 1) {
    const bucket = String(index % 20).padStart(2, "0");
    const directory = join(workspace, CONVERSATION, "data", bucket);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `file-${String(index).padStart(4, "0")}.txt`),
      `deterministic-payload-${index}-${"x".repeat(64)}\n`,
    );
  }
  return { fixture, workspace, outsideSecret };
}

function locateInRoots(roots, projectedPath) {
  const safePath = validateProjectedPath(projectedPath);
  const [head, ...tail] = safePath.split("/");
  const root = roots.find(([target]) => target === head);
  if (!root) throw new Error(`Path is not projected: ${projectedPath}`);
  return join(root[1], ...tail);
}

function directProjection(workspace, conversationId) {
  const roots = selectedRoots(workspace, conversationId);
  return projectionApi(
    "direct",
    (path) => locateInRoots(roots, path),
    () => {},
  );
}

function copyProjection(workspace, conversationId, scratch) {
  const stage = join(scratch, "materialized");
  mkdirSync(stage, { recursive: true });
  for (const [target, source] of selectedRoots(workspace, conversationId)) {
    cpSync(source, join(stage, target), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }
  return projectionApi(
    "copy",
    (path) => join(stage, validateProjectedPath(path)),
    () => {},
  );
}

function walkManifest(sourceRoot, targetRoot, manifest) {
  const rootStat = lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink()) return;
  if (rootStat.isFile()) {
    manifest.set(targetRoot, sourceRoot);
    return;
  }
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const target = posix.join(targetRoot, entry.name);
    if (entry.isDirectory()) walkManifest(source, target, manifest);
    else if (entry.isFile()) manifest.set(target, source);
    // Policy decision: omit every symlink, including internal and broken links.
  }
}

function manifestProjection(workspace, conversationId) {
  const manifest = new Map();
  for (const [target, source] of selectedRoots(workspace, conversationId)) {
    walkManifest(source, target, manifest);
  }
  return projectionApi(
    "manifest",
    (path) => {
      const safePath = validateProjectedPath(path);
      const source = manifest.get(safePath);
      if (!source) throw new Error(`Path is not allowed by manifest: ${path}`);
      return source;
    },
    () => manifest.size,
  );
}

function projectionApi(name, locate, metadataSize) {
  return {
    name,
    metadataSize,
    read(path) {
      return readFileSync(locate(path), "utf8");
    },
    write(path, value) {
      writeFileSync(locate(path), value);
    },
  };
}

function createProjection(strategy, workspace, conversationId, scratch) {
  if (strategy === "direct") return directProjection(workspace, conversationId);
  if (strategy === "copy") return copyProjection(workspace, conversationId, scratch);
  if (strategy === "manifest") return manifestProjection(workspace, conversationId);
  throw new Error(`Unknown strategy: ${strategy}`);
}

function assertThrows(action, pattern) {
  assert.throws(action, pattern);
}

function testVisibility(strategy) {
  const fixture = makeFixture(10);
  const scratch = join(fixture.fixture, `scratch-${strategy}`);
  try {
    const projection = createProjection(strategy, fixture.workspace, CONVERSATION, scratch);
    assert.equal(projection.read("MEMORY.md"), "shared-memory-v1\n");
    assert.equal(projection.read("skills/guide.md"), "skill-guide\n");
    assert.equal(projection.read("events/event.json"), '{"event":1}\n');
    assert.equal(projection.read(`${CONVERSATION}/note.txt`), "conversation-a-v1\n");
    assertThrows(
      () => projection.read("conversation-b/private.txt"),
      /not projected|not allowed|ENOENT/,
    );
    assertThrows(() => projection.read("host-only.txt"), /not projected|not allowed|ENOENT/);
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

function testMutation(strategy) {
  const fixture = makeFixture(0);
  const scratch = join(fixture.fixture, `scratch-${strategy}`);
  try {
    const projection = createProjection(strategy, fixture.workspace, CONVERSATION, scratch);
    projection.write(`${CONVERSATION}/note.txt`, "projected-write\n");
    const hostAfterProjectedWrite = readFileSync(
      join(fixture.workspace, CONVERSATION, "note.txt"),
      "utf8",
    );
    if (strategy === "copy") assert.equal(hostAfterProjectedWrite, "conversation-a-v1\n");
    else assert.equal(hostAfterProjectedWrite, "projected-write\n");

    writeFileSync(join(fixture.workspace, "MEMORY.md"), "host-write-v2\n");
    if (strategy === "copy") assert.equal(projection.read("MEMORY.md"), "shared-memory-v1\n");
    else assert.equal(projection.read("MEMORY.md"), "host-write-v2\n");
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

function testSymlinks(strategy) {
  const fixture = makeFixture(0);
  const scratch = join(fixture.fixture, `scratch-${strategy}`);
  try {
    const projection = createProjection(strategy, fixture.workspace, CONVERSATION, scratch);
    if (strategy === "manifest") {
      assertThrows(() => projection.read(`${CONVERSATION}/escape-link`), /not allowed/);
      assertThrows(() => projection.read("skills/memory-link"), /not allowed/);
      assertThrows(() => projection.read(`${CONVERSATION}/broken-link`), /not allowed/);
    } else {
      assert.equal(projection.read(`${CONVERSATION}/escape-link`), "outside-secret\n");
      assert.equal(projection.read("skills/memory-link"), "shared-memory-v1\n");
      assertThrows(() => projection.read(`${CONVERSATION}/broken-link`), /ENOENT/);
    }
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

function testTraversal(strategy) {
  const fixture = makeFixture(0);
  try {
    for (const id of ["", ".", "..", "../escape", "a/b", "a\\b", "bad\0id"]) {
      assertThrows(
        () =>
          createProjection(
            strategy,
            fixture.workspace,
            id,
            join(fixture.fixture, "scratch-invalid"),
          ),
        /safe path segment/,
      );
    }
    const projection = createProjection(
      strategy,
      fixture.workspace,
      CONVERSATION,
      join(fixture.fixture, `scratch-${strategy}`),
    );
    for (const path of [
      "../outside-secret.txt",
      `${CONVERSATION}/../host-only.txt`,
      "/etc/passwd",
    ]) {
      assertThrows(() => projection.read(path), /relative path|traversal/);
    }
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean,
  };
}

function benchmarkStrategy(strategy, fixture) {
  const setupSamples = [];
  const runtimeSamples = [];
  let metadataSize = 0;
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const scratch = join(fixture.fixture, `bench-${strategy}-${sample}`);
    const setupStart = performance.now();
    const projection = createProjection(strategy, fixture.workspace, CONVERSATION, scratch);
    setupSamples.push(performance.now() - setupStart);
    metadataSize = projection.metadataSize();

    const runtimeStart = performance.now();
    let bytes = 0;
    for (let readIndex = 0; readIndex < READS_PER_SAMPLE; readIndex += 1) {
      const fileIndex = (readIndex * 97) % FIXTURE_FILE_COUNT;
      const bucket = String(fileIndex % 20).padStart(2, "0");
      bytes += projection.read(
        `${CONVERSATION}/data/${bucket}/file-${String(fileIndex).padStart(4, "0")}.txt`,
      ).length;
    }
    runtimeSamples.push(performance.now() - runtimeStart);
    assert.ok(bytes > 0);
  }
  return {
    setup: summarize(setupSamples),
    runtime: summarize(runtimeSamples),
    metadataSize,
  };
}

function formatNumber(value) {
  return value.toFixed(3);
}

function renderResults(benchmarks) {
  const rows = STRATEGIES.map((strategy) => {
    const result = benchmarks[strategy];
    return `| ${strategy} | ${formatNumber(result.setup.min)} | ${formatNumber(result.setup.median)} | ${formatNumber(result.setup.p95)} | ${formatNumber(result.setup.mean)} | ${formatNumber(result.runtime.median)} | ${formatNumber(result.runtime.p95)} | ${result.metadataSize} |`;
  }).join("\n");
  return `# Workspace projection experiment results

> Throwaway research artifact; these are userspace models, not real mount syscalls. Generated by \`node scripts/experiments/workspace-projection/experiment.mjs\`.

## Environment and workload

- Node: ${process.version}
- Platform: ${process.platform} ${process.arch}
- Deterministic fixture: ${FIXTURE_FILE_COUNT} payload files in 20 directories, plus shared/conversation/hidden files and three symlink cases
- Samples: ${SAMPLE_COUNT} independent setup + runtime samples per strategy
- Runtime sample: ${READS_PER_SAMPLE} deterministic file reads
- Correctness checks: visibility, bidirectional mutation behavior, external/internal/broken symlinks, unsafe conversation IDs, and projected-path traversal

## Correctness matrix

| Property | direct bind-list model | copy/materialized model | manifest/policy model |
|---|---|---|---|
| Only four selected roots visible | pass | pass | pass |
| Projected writes reach host | yes | no (isolated snapshot) | yes |
| Later host writes visible | yes | no (isolated snapshot) | yes |
| Absolute symlink escaping workspace | followed (unsafe) | followed (unsafe) | rejected |
| Internal symlink | followed | followed | rejected (conservative) |
| Broken symlink | exposed, fails on read | exposed, fails on read | omitted/rejected |
| Unsafe conversation ID | rejected | rejected | rejected |
| Read-path traversal | rejected by experiment API | rejected by experiment API | rejected by experiment API |

## Timing results (milliseconds)

| Strategy | setup min | setup median | setup p95 | setup mean | 200 reads median | 200 reads p95 | manifest entries |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows}

Timing is comparative, not a production prediction: the direct strategy measures list construction rather than kernel mount setup; copy measures real filesystem copying; manifest measures real recursive policy scanning. OS cache state and machine load remain uncontrolled.

## Interpretation

1. **Direct fixed mounts are the simplest and fastest, but the boundary is only as strong as the selected trees.** A symlink inside an allowed conversation directory can still point to a host path outside the workspace. Lexical conversation-id validation does not address descendants.
2. **Copying buys mutation isolation, not automatically confinement.** Preserving symlinks copied the external absolute target unchanged, so staging alone retained the escape. A secure materializer must reject links, dereference only after containment checks, or rewrite safe internal links.
3. **A manifest makes policy explicit and testable, at setup cost proportional to tree size.** The conservative model omitted all symlinks and prevented escape, but also removed legitimate internal links. It remained host-backed, so it did not provide snapshot isolation.
4. **Path validation belongs at every policy boundary.** Safe conversation IDs protect root selection; projected path validation separately protects lookup. Real bind-mounted processes also need container-level destination confinement rather than relying on this experiment API.
5. **Likely practical hybrid:** validate the four roots, recursively build a manifest using \`lstat\`, permit regular files/directories, and handle symlinks with an explicit policy based on \`realpath\` containment. Materialize only when snapshot/write isolation is required. This costs more than four mounts but makes the security contract inspectable.

## Reproduction

\`\`\`sh
node scripts/experiments/workspace-projection/experiment.mjs
\`\`\`

The command runs all assertions first, then benchmarks, and rewrites this file only after every check passes.
`;
}

function main() {
  for (const strategy of STRATEGIES) {
    testVisibility(strategy);
    testMutation(strategy);
    testSymlinks(strategy);
    testTraversal(strategy);
  }
  const fixture = makeFixture();
  try {
    const benchmarks = Object.fromEntries(
      STRATEGIES.map((strategy) => [strategy, benchmarkStrategy(strategy, fixture)]),
    );
    const outputPath = join(dirname(fileURLToPath(import.meta.url)), "RESULTS.md");
    writeFileSync(outputPath, renderResults(benchmarks));
    console.log(`PASS: 12 correctness groups (${STRATEGIES.length} strategies × 4 groups)`);
    console.log(`PASS: ${SAMPLE_COUNT} benchmark samples per strategy`);
    console.log(`Wrote ${relative(process.cwd(), outputPath)}`);
  } finally {
    rmSync(fixture.fixture, { recursive: true, force: true });
  }
}

main();
