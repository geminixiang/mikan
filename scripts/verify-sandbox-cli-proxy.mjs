#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerContainerManager } from "../dist/provisioner.js";
import { ContainerExecutor } from "../dist/sandbox/container.js";

const image = process.env.MIKAN_VERIFY_SANDBOX_IMAGE || "node:22-alpine";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const key = `cli-proxy-${suffix}`.replace(/[^a-z0-9-]/g, "-");
const containerName = `mikan-sandbox-${key}`;
const upstreamName = `mikan-upstream-${key}`;
const networkName = DockerContainerManager.networkName(key);
const workspace = mkdtempSync(join(tmpdir(), "mikan-cli-proxy-workspace-"));
const upstreamDir = mkdtempSync(join(tmpdir(), "mikan-cli-proxy-upstream-"));
const manager = new DockerContainerManager(image);

const cliNames = ["gh", "gcloud", "gws", "sentry-cli"];

writeFileSync(
  join(upstreamDir, "server.mjs"),
  `import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
mkdirSync('/tmp/seen', { recursive: true });
createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  appendFileSync('/tmp/seen/' + name, String(req.headers.authorization || '') + '\\n');
  res.end('ok');
}).listen(8080, '0.0.0.0');
`,
);

mkdirSync(join(workspace, "bin"), { recursive: true });
for (const name of cliNames) {
  writeFileSync(
    join(workspace, "bin", name),
    `#!/bin/sh
set -eu
wget -T 5 -qO- "http://upstream:8080/${encodeURIComponent(name)}" >/dev/null
`,
    { mode: 0o755 },
  );
}

try {
  await manager.provision(key, {
    containerName,
    conversationId: "D123",
    mounts: [{ source: workspace, target: "/workspace" }],
  });
  execFileSync("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    upstreamName,
    "--network",
    networkName,
    "--network-alias",
    "upstream",
    "-v",
    `${upstreamDir}:/app`,
    "node:22-alpine",
    "node",
    "/app/server.mjs",
  ]);
  execFileSync("docker", [
    "exec",
    containerName,
    "sh",
    "-lc",
    "for i in $(seq 1 50); do wget -T 1 -qO- http://upstream:8080/health >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1",
  ]);

  const executor = new ContainerExecutor(
    containerName,
    {
      env: {
        MIKAN_PROXY_INJECT_HEADERS: JSON.stringify({
          "upstream:8080": { authorization: "Bearer cli-proxy-secret" },
        }),
      },
    },
    async () =>
      manager.provision(key, {
        containerName,
        conversationId: "D123",
        mounts: [{ source: workspace, target: "/workspace" }],
      }),
  );

  await Promise.all(
    cliNames.map(async (name) => {
      const result = await executor.exec(`PATH=/workspace/bin:$PATH ${name}`, { timeout: 10 });
      if (result.code !== 0) {
        throw new Error(`${name} proxy smoke failed: ${result.stderr}`);
      }
      const seen = execFileSync("docker", ["exec", upstreamName, "cat", `/tmp/seen/${name}`], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .at(-1);
      if (seen !== "Bearer cli-proxy-secret") {
        throw new Error(`${name} did not send injected header, got ${seen}`);
      }
    }),
  );

  const leaked = execFileSync(
    "docker",
    ["exec", containerName, "sh", "-lc", "env | grep MIKAN_PROXY_INJECT_HEADERS || true"],
    { encoding: "utf8" },
  );
  if (leaked.trim()) throw new Error("MIKAN_PROXY_INJECT_HEADERS leaked into base container env");

  console.log(JSON.stringify({ ok: true, image, cliNames }, null, 2));
} finally {
  try {
    execFileSync("docker", ["rm", "-f", upstreamName]);
  } catch {}
  try {
    await manager.remove(key);
  } catch {}
  rmSync(workspace, { recursive: true, force: true });
  rmSync(upstreamDir, { recursive: true, force: true });
}
