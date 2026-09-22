const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

module.exports = {
  apps: [
    {
      name: "mikan",
      script: "mikan",

      args: "--sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest ./workspace",

      env: loadEnvFile(path.join(os.homedir(), ".mikan", "mikan.env")),

      kill_timeout: 360000,

      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,

      time: true,
      merge_logs: true,
    },
  ],
};
