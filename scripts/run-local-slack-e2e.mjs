// Authorized real-platform tests only. See docs/testing/slack-e2e.md first.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { spawn } from "node:child_process";

const repo = new URL("../", import.meta.url).pathname;
const source = process.env.SLACK_QA_CONFIG_DIR ?? join(homedir(), ".mikan");
const envFile = join(source, "mikan.env");
const env = {
  ...process.env,
  ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {}),
};
for (const key of [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_QA_USER_TOKEN",
  "SLACK_QA_CHANNEL_ID",
]) {
  if (!env[key]) throw new Error(`Missing ${key}; set it before running real Slack E2E`);
}
// Confirm identities without printing any credentials.
async function identity(token) {
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const auth = await response.json();
  if (!auth.ok) throw new Error(`Slack authentication failed: ${auth.error}`);
  return auth;
}
const botAuth = await identity(env.SLACK_BOT_TOKEN);
const userAuth = await identity(env.SLACK_QA_USER_TOKEN);
if (botAuth.team_id !== userAuth.team_id || botAuth.user_id === userAuth.user_id)
  throw new Error("QA requires distinct bot/user identities in the same workspace");
const base = mkdtempSync(join(tmpdir(), "mikan-slack-e2e-"));
chmodSync(base, 0o700);
const settings = JSON.parse(readFileSync(join(source, "settings.json"), "utf8"));
// Disposable local QA intentionally uses host execution; never changes user settings.
settings.sandbox = { workspace: { doorPolicy: "trusted", layout: "full" } };
delete settings.sentry;
delete settings.observability;
writeFileSync(join(base, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
mkdirSync(join(base, "workspace"));
for (const key of Object.keys(env)) if (/^(SENTRY_|OTEL_|OTLP_)/.test(key)) delete env[key];
Object.assign(env, {
  MIKAN_STATE_DIR: base,
  SENTRY_ENABLED: "false",
  LINK_PORT: "",
  GITHUB_TOKEN: "",
  DISCORD_BOT_TOKEN: "",
  TELEGRAM_BOT_TOKEN: "",
  SLACK_QA_BOT_USER_ID: botAuth.user_id,
  SLACK_QA_WORKING_DIR: join(base, "workspace"),
  SLACK_QA_EVENTS_DIR: join(base, "workspace", "events"),
  SLACK_QA_TIMEOUT_MS: env.SLACK_QA_TIMEOUT_MS ?? "60000",
});
console.log(
  JSON.stringify({ workspace: botAuth.team_id, artifacts: base, model: settings.llm?.model }),
);
function launch(args, log) {
  const fd = openSync(join(base, log), "a", 0o600);
  const child = spawn(process.execPath, args, { cwd: repo, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const exited = new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
  return { child, exited };
}
const daemon = launch(
  ["dist/main.js", "--state-dir", base, join(base, "workspace"), "--sandbox", "host"],
  "daemon.log",
);
let tests;
const stop = () => {
  tests?.child.kill("SIGTERM");
  daemon.child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  let connected = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (readFileSync(join(base, "daemon.log"), "utf8").includes("connected to Slack")) {
      connected = true;
      break;
    }
    if (daemon.child.exitCode !== null)
      throw new Error("Test daemon exited; inspect private daemon.log");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!connected) throw new Error("Slack connection timeout; inspect private daemon.log");
  const filters = process.argv.slice(2);
  tests = launch(
    [
      "node_modules/vitest/vitest.mjs",
      "--run",
      "--config",
      ".config/vitest.e2e.config.ts",
      ...(filters.length ? filters : ["e2e/slack"]),
    ],
    "tests.log",
  );
  const code = await tests.exited;
  console.log(JSON.stringify({ testExitCode: code, testLog: join(base, "tests.log") }));
  process.exitCode = code ?? 1;
} finally {
  stop();
  const deadline = setTimeout(() => daemon.child.kill("SIGKILL"), 30000);
  await daemon.exited;
  clearTimeout(deadline);
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  console.log("Local QA daemon stopped; private artifacts retained.");
}
