// PM2 ecosystem file for mikan.
//
// Quick start:
//
//   # 1. Install mikan + pm2
//   npm i -g @geminixiang/mikan pm2
//
//   # 2. Pull and start the sandbox container (long-lived, mikan execs into it)
//   docker pull ghcr.io/geminixiang/mikan-sandbox:latest
//   docker run -d --name rd-sandbox --restart unless-stopped \
//     ghcr.io/geminixiang/mikan-sandbox:latest
//
//   # 3. Grab this ecosystem file, edit `args` + `env`, then start
//   curl -O https://raw.githubusercontent.com/geminixiang/mikan/main/deploy/pm2/ecosystem.config.cjs
//   pm2 start ecosystem.config.cjs
//   pm2 save
//   pm2 startup    # run the printed command to enable boot autostart
//
// Reload after upgrading mikan:
//   npm i -g @geminixiang/mikan && pm2 reload mikan
//
// Logs:
//   pm2 logs mikan         # tail combined logs
//   pm2 logs mikan --lines 200
//
// Args reference (see `mikan --help` equivalent in src/main.ts):
//   <working-directory>           required positional, the git repo mikan operates on
//   --state-dir=<dir>             defaults to ~/.mikan (where settings.json + vaults live)
//   --sandbox=<spec>              one of:
//                                   container:<existing-container-name>   (recommended)
//                                   image:<image-name>                    (mikan-managed per-user)
//                                   host
//                                   firecracker:<vm-id>:<host-path>
//                                   cloudflare:<sandbox-id>
//
// Notes:
// - kill_timeout is 60s to give mikan's internal graceful shutdown
//   (handler.shutdown defaults to 30s) room to drain in-flight LLM
//   turns before pm2 sends SIGKILL.
// - The sandbox container should be started with `--restart unless-stopped`
//   so it comes back on reboot before mikan (which pm2 startup also brings
//   up) tries to exec into it. Docker's daemon starts before pm2's unit.

module.exports = {
  apps: [
    {
      name: "mikan",
      script: "mikan",

      // EDIT ME: working dir + sandbox to match your setup.
      args: "--sandbox=image:ghcr.io/geminixiang/mikan-sandbox:latest ./workspace",

      // EDIT ME: uncomment what you need. Prefer loading secrets from
      // a sourced env file or pm2's --env-file rather than committing
      // them here.
      env: {
        SLACK_APP_TOKEN: "",
        SLACK_BOT_TOKEN: "",
        TELEGRAM_BOT_TOKEN: "",
        DISCORD_BOT_TOKEN: "",

        // GitHub adapter (issue/PR conversations): create a GitHub App
        // (Issues + Pull requests read/write, webhook off), install it,
        // then point the key path at the downloaded .pem — keep the key
        // outside any repo. GITHUB_REPOS defaults to every installed repo;
        // GITHUB_POLL_INTERVAL is in seconds (default 60).
        GITHUB_APP_ID: "",
        GITHUB_APP_PRIVATE_KEY_PATH: "",
        GITHUB_INSTALLATION_ID: "",
        GITHUB_REPOS: "",
        GITHUB_POLL_INTERVAL: "",
        // Host-side GCP credentials (e.g. a WIF external_account file)
        // unlock Cloud Build logs in github_checks.
        GOOGLE_APPLICATION_CREDENTIALS: "",
        GOOGLE_CLOUD_PROJECT: "",

        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        MIKAN_LINK_URL: "",
        MIKAN_LINK_PORT: "",
        // OAuth app for /login credential linking — unrelated to the
        // GitHub adapter's App credentials above.
        GITHUB_OAUTH_CLIENT_ID: "",
        GITHUB_OAUTH_CLIENT_SECRET: "",
        GOOGLE_WORKSPACE_CLI_CLIENT_ID: "",
        GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: "",
        MIKAN_CLOUDFLARE_SANDBOX_URL: "",
        MIKAN_CLOUDFLARE_SANDBOX_TOKEN: "",
        // Settings.json sentry.dsn wins over this env fallback.
        SENTRY_DSN: "",
      },

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
