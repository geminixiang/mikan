---
title: 部署
description: 使用 PM2、Docker sandbox image 與 state directory 部署長時間執行的 mikan。
---

## PM2

長時間執行的部署建議使用 [PM2](https://pm2.keymetrics.io/) 作為程序 supervisor。它會將 mikan daemonize、在 crash 時重新啟動，並可在重開機後繼續運作。

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

升級流程：

```bash
npm i -g @geminixiang/mikan && pm2 reload mikan
```

`pm2 reload` 會送出 SIGTERM，並在送出 SIGKILL 前最多等待 `kill_timeout`（隨附設定中為 60s）。mikan 內部的 graceful shutdown 會在這段時間內排空進行中的 LLM turns，因此 reload 不會中斷使用中的對話。

所有可調整項目請見 [`../deploy/pm2/ecosystem.config.cjs`](../deploy/pm2/ecosystem.config.cjs)。
