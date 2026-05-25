---
title: Deployment
description: Deploy mikan with PM2, Docker, and other process managers.
---

## PM2

For long-running deployments, use [PM2](https://pm2.keymetrics.io/) as a process supervisor. It daemonizes mikan, restarts on crash, and survives reboots.

```bash
# 1. Install mikan and pm2
npm i -g @geminixiang/mikan pm2

# 2. Start the sandbox container/image dependency you plan to use
docker pull ghcr.io/geminixiang/mikan-sandbox:latest

# 3. Grab the ecosystem file, edit args + env tokens, then start
curl -O https://raw.githubusercontent.com/geminixiang/mikan/main/deploy/pm2/ecosystem.config.cjs
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup        # run the printed command to enable boot autostart
```

Upgrade flow:

```bash
npm i -g @geminixiang/mikan && pm2 reload mikan
```

`pm2 reload` sends SIGTERM and waits up to `kill_timeout` (60s in the shipped config) before SIGKILL. mikan's internal graceful shutdown drains in-flight LLM turns within that window, so reloads do not interrupt active conversations.

See [`../deploy/pm2/ecosystem.config.cjs`](../deploy/pm2/ecosystem.config.cjs) for all tunables.
