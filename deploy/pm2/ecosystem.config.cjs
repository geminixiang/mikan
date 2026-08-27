// PM2 ecosystem file for mikan — process supervision only.
//
// Configuration lives elsewhere, on purpose:
//   - behavior (model, sandbox limits, reply modes): <state-dir>/settings.json
//     (create with `mikan onboard`, edit via the Admin portal or the file)
//   - secrets and platform tokens: ~/.mikan/mikan.env (0600, outside any
//     repo tree) — this file loads it below. Start from the annotated
//     example: deploy/pm2/mikan.env.example. Run `mikan env` to see the
//     full inventory and what is currently set.
//   - CLI flags (`args` below): run `mikan --help` for the reference.
//
// Quick start:
//
//   # 1. Install mikan + pm2
//   npm i -g @geminixiang/mikan pm2
//
//   # 2. One-time setup: settings + secrets
//   mikan onboard        # interactive: adapter + LLM + sandbox → settings.json,
//                        # ~/.mikan/mikan.env (0600), models.json as needed.
//   # For the full variable inventory start from the annotated example:
//   #   curl -o ~/.mikan/mikan.env .../deploy/pm2/mikan.env.example
//
//   # 3. (image sandbox) pull the sandbox image
//   docker pull ghcr.io/geminixiang/mikan-sandbox:latest
//
//   # 4. Grab this file, edit `args`, then start
//   curl -O https://raw.githubusercontent.com/geminixiang/mikan/main/deploy/pm2/ecosystem.config.cjs
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # run the printed command to enable boot autostart
//
// Reload after upgrading mikan (or after editing mikan.env):
//   npm i -g @geminixiang/mikan && pm2 reload mikan
//
// Logs:
//   pm2 logs mikan         # tail combined logs
//
// Notes:
// - kill_timeout is 60s to give mikan's internal graceful shutdown
//   (handler.shutdown defaults to 30s) room to drain in-flight LLM
//   turns before pm2 sends SIGKILL.
// - A `container:` sandbox should be started with `--restart unless-stopped`
//   so it comes back on reboot before mikan tries to exec into it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Minimal KEY=value env-file loader (no dotenv dependency): blank lines and
 * `#` comments skipped, surrounding single/double quotes stripped. Returning
 * {} when the file is missing lets `pm2 start` fail later with mikan's own
 * "no platform tokens" message, which names the vars to set.
 */
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

      // EDIT ME: sandbox mode + working directory (see `mikan --help`).
      args: "--sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest ./workspace",

      // Secrets and tokens come from the env file, never from this file.
      env: loadEnvFile(path.join(os.homedir(), ".mikan", "mikan.env")),

      // Graceful shutdown: SIGTERM, then wait up to 60s before SIGKILL.
      kill_timeout: 60000,

      // Auto-restart policy.
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,

      // Log formatting (~/.pm2/logs/mikan-out.log + mikan-error.log).
      time: true,
      merge_logs: true,
    },
  ],
};
